import { Hono } from 'hono';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import { z, ZodError } from 'zod';
import type { Env } from '@basma/shared/types';
import { transcribeAudio, synthesizeSpeech } from '@basma/shared/speech';
import { createRequestId, log, writeAudit } from '@basma/shared/logger';

type AuthUser = { sub: string; role?: string; email?: string };
type AppContext = Context<{ Bindings: Env; Variables: { rid: string; user?: AuthUser } }>;
const PUBLIC_PATHS: readonly string[] = ['/health', '/version', '/time', '/stt', '/tts'];
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MIN_PAGE = 1;
const MIN_LIMIT = 1;

const app = new Hono<{ Bindings: Env; Variables: { rid: string; user?: AuthUser } }>();
app.use('/*', cors());

// Structured logging + request id
app.use('*', async (c, next) => {
  const rid = c.req.header('x-request-id') || createRequestId();
  c.set('rid', rid);
  const start = Date.now();
  log('info', 'request_start', { rid, method: c.req.method, path: new URL(c.req.url).pathname });
  try {
    await next();
  } finally {
    log('info', 'request_end', { rid, status: c.res.status, ms: Date.now() - start });
  }
});

// JWT Auth middleware with role support
app.use('*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (PUBLIC_PATHS.includes(path)) {
    return next();
  }
  const auth = c.req.header('authorization');
  if (!auth?.startsWith('Bearer ')) {
    return jsonError(c, 'unauthorized', 'Missing or invalid authorization header', 401);
  }
  try {
    const token = auth.replace('Bearer ', '');
    const user = await verifyJwt(token, c.env.JWT_SECRET);
    c.set('user', user);
    return next();
  } catch (err) {
    log('warn', 'auth_failed', { rid: c.get('rid'), error: String(err) });
    return jsonError(c, 'unauthorized', 'Invalid or expired token', 401);
  }
});

// Global error handling
app.onError((err, c) => {
  log('error', 'unhandled_error', { rid: c.get('rid'), error: String(err) });
  return jsonError(c, 'internal_error', 'Internal server error', 500);
});
app.notFound((c) => jsonError(c, 'not_found', 'Not found', 404));

app.get('/health', (c) => c.json({ ok: true, env: c.env.ENVIRONMENT }));

app.get('/version', (c) => c.json({ name: 'basma-api', version: '1.0.0' }));

app.get('/time', (c) => c.json({ now: Date.now() }));

// Appointments CRUD
app.get('/appointments', async (c) => {
  const userId = c.req.query('user_id');
  const status = c.req.query('status');
  const search = c.req.query('search');
  const { limit, offset } = getPagination(c);
  const safeSearch = search ? escapeLike(search) : null;

  const where: string[] = [];
  const params: any[] = [];
  if (userId) {
    where.push('user_id = ?');
    params.push(userId);
  }
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  if (safeSearch) {
    const like = `%${safeSearch}%`;
    where.push(`(title LIKE ? ESCAPE '\\\\' OR coalesce(description, "") LIKE ? ESCAPE '\\\\')`);
    params.push(like, like);
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const result = await c.env.DB.prepare(
    `SELECT * FROM appointments ${whereClause} ORDER BY start_time DESC LIMIT ? OFFSET ?`
  ).bind(...params, limit, offset).all();
  return c.json({ data: result.results || [], pagination: { limit, offset } });
});

app.get('/appointments/:id', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(`SELECT * FROM appointments WHERE id = ?`).bind(id).first();
  if (!row) return jsonError(c, 'not_found', 'Appointment not found', 404);
  return c.json(row);
});

app.post('/appointments', async (c) => {
  const body = await parseBody(c, appointmentCreateSchema);
  if (body instanceof Response) return body;
  const id = crypto.randomUUID();
  const now = Date.now();

  await c.env.DB.prepare(`
    INSERT INTO appointments (
      id, user_id, visitor_id, title, description, type,
      start_time, end_time, timezone, status, meeting_link, location,
      attendees, reminders_sent, notes, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    body.user_id,
    body.visitor_id || null,
    body.title,
    body.description ?? null,
    body.type,
    body.start_time,
    body.end_time,
    body.timezone,
    body.meeting_link ?? null,
    body.location ?? null,
    body.attendees ? JSON.stringify(body.attendees) : null,
    body.reminders_sent ? JSON.stringify(body.reminders_sent) : null,
    body.notes ?? null,
    now,
    now
  ).run();
  await writeAudit(c.env, { action: 'create', resource_type: 'appointment', resource_id: id, changes: body, user_id: c.get('user')?.sub });
  return c.json({ id }, 201);
});

app.patch('/appointments/:id', async (c) => {
  const id = c.req.param('id');
  const body = await parseBody(c, appointmentUpdateSchema);
  if (body instanceof Response) return body;
  const fields: string[] = [];
  const values: any[] = [];
  for (const [k, v] of Object.entries(body)) {
    fields.push(`${k} = ?`);
    if (k === 'attendees' || k === 'reminders_sent') values.push(v ? JSON.stringify(v) : null);
    else values.push(v);
  }
  if (!fields.length) return jsonError(c, 'validation_error', 'No fields to update', 400);
  fields.push('updated_at = ?');
  values.push(Date.now(), id);
  await c.env.DB.prepare(`UPDATE appointments SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();
  await writeAudit(c.env, { action: 'update', resource_type: 'appointment', resource_id: id, changes: body, user_id: c.get('user')?.sub });
  return c.json({ id });
});

app.delete('/appointments/:id', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare(`DELETE FROM appointments WHERE id = ?`).bind(id).run();
  await writeAudit(c.env, { action: 'delete', resource_type: 'appointment', resource_id: id, user_id: c.get('user')?.sub });
  return c.body(null, 204);
});

// Visitor / Leads CRUD
app.get('/visitors', async (c) => {
  const userId = c.req.query('user_id');
  const status = c.req.query('status');
  const search = c.req.query('search');
  const { limit, offset } = getPagination(c);
  const safeSearch = search ? escapeLike(search) : null;

  const where: string[] = [];
  const params: any[] = [];
  if (userId) {
    where.push('user_id = ?');
    params.push(userId);
  }
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  if (safeSearch) {
    const like = `%${safeSearch}%`;
    where.push('(coalesce(name, "") LIKE ? ESCAPE \'\\\\\' OR coalesce(email, "") LIKE ? ESCAPE \'\\\\\' OR coalesce(phone, "") LIKE ? ESCAPE \'\\\\\')');
    params.push(like, like, like);
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const result = await c.env.DB.prepare(
    `SELECT * FROM visitors ${whereClause} ORDER BY last_contact DESC LIMIT ? OFFSET ?`
  ).bind(...params, limit, offset).all();
  return c.json({ data: result.results || [], pagination: { limit, offset } });
});

app.post('/visitors', async (c) => {
  const body = await parseBody(c, visitorSchema);
  if (body instanceof Response) return body;
  const id = body.id || crypto.randomUUID();
  const now = Date.now();
  
  // Check if visitor exists
  const existing = await c.env.DB.prepare('SELECT id FROM visitors WHERE phone = ? OR email = ?').bind(body.phone, body.email).first();
  
  if (existing) {
    await c.env.DB.prepare(`
      UPDATE visitors SET 
        name = coalesce(?, name),
        email = coalesce(?, email),
        last_contact = ?,
        total_interactions = total_interactions + 1,
        lead_score = ?,
        status = coalesce(?, status)
      WHERE id = ?
    `).bind(body.name, body.email, now, body.lead_score || 0, body.status, existing.id).run();
    return c.json({ id: existing.id, updated: true });
  }

  await c.env.DB.prepare(`
    INSERT INTO visitors (
      id, user_id, name, phone, email, source, lead_score, status, first_contact, last_contact, total_interactions
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).bind(
    id,
    body.user_id || getActorId(c),
    body.name || null,
    body.phone || null,
    body.email || null,
    body.source || 'manual',
    body.lead_score ?? 0,
    body.status || 'new',
    now,
    now
  ).run();
  await writeAudit(c.env, { action: 'create', resource_type: 'visitor', resource_id: id, changes: body, user_id: c.get('user')?.sub });
  return c.json({ id }, 201);
});

// Call Logs
app.get('/logs', async (c) => {
  const status = c.req.query('status');
  const { limit, offset } = getPagination(c);
  const where: string[] = [];
  const params: any[] = [];
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const result = await c.env.DB.prepare(
    `SELECT * FROM call_logs ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).bind(...params, limit, offset).all();
  return c.json({ data: result.results || [], pagination: { limit, offset } });
});

app.post('/logs', async (c) => {
  const body = await parseBody(c, callLogSchema);
  if (body instanceof Response) return body;
  const id = crypto.randomUUID();
  const now = Date.now();
  const duration = body.duration_seconds ?? 0;
  await c.env.DB.prepare(`
    INSERT INTO call_logs (
      id, user_id, visitor_id, call_type, direction, duration_seconds, 
      status, summary, sentiment, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    body.user_id || getActorId(c),
    body.visitor_id,
    body.call_type || 'inbound',
    body.direction || 'incoming',
    duration,
    body.status || 'completed',
    body.summary || null,
    body.sentiment || null,
    now
  ).run();
  
  if (body.visitor_id) {
     await c.env.DB.prepare('UPDATE visitors SET last_contact = ?, total_interactions = total_interactions + 1 WHERE id = ?').bind(now, body.visitor_id).run();
  }
  
  await writeAudit(c.env, { action: 'create', resource_type: 'call_log', resource_id: id, changes: body, user_id: c.get('user')?.sub });
  return c.json({ id }, 201);
});

// Messages (WhatsApp/SMS) -- Mock sending, just store
app.post('/messages', async (c) => {
  const body = await parseBody(c, messageSchema);
  if (body instanceof Response) return body;
  const id = crypto.randomUUID();
  const now = Date.now();
  
  await c.env.DB.prepare(`
    INSERT INTO messages (
      id, conversation_id, visitor_id, channel, direction, content, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    'conv_' + id, // Simple conversation ID generation
    body.visitor_id,
    body.channel || 'sms',
    body.direction || 'outbound',
    body.content,
    body.status || 'sent',
    now
  ).run();
  
  await writeAudit(c.env, { action: 'create', resource_type: 'message', resource_id: id, changes: body, user_id: c.get('user')?.sub });
  return c.json({ id, status: 'sent' }, 201);
});

// Dashboard Aggregation
app.get('/dashboard', async (c) => {
  const [appointments, logs, visitors, leads] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM appointments ORDER BY start_time DESC LIMIT 5').all(),
    c.env.DB.prepare('SELECT * FROM call_logs ORDER BY created_at DESC LIMIT 5').all(),
    c.env.DB.prepare('SELECT * FROM visitors ORDER BY last_contact DESC LIMIT 5').all(),
    c.env.DB.prepare("SELECT * FROM visitors WHERE status IN ('qualified', 'converted') OR lead_score > 50 ORDER BY last_contact DESC LIMIT 5").all()
  ]);
  
  return c.json({
    appointments: appointments.results,
    logs: logs.results,
    visitors: visitors.results,
    leads: leads.results
  });
});

// Tasks CRUD
app.get('/tasks', async (c) => {
  const userId = c.req.query('user_id');
  const status = c.req.query('status');
  const search = c.req.query('search');
  const { limit, offset } = getPagination(c);
  const safeSearch = search ? escapeLike(search) : null;

  const where: string[] = [];
  const params: any[] = [];
  if (userId) {
    where.push('user_id = ?');
    params.push(userId);
  }
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  if (safeSearch) {
    const like = `%${safeSearch}%`;
    where.push(`(title LIKE ? ESCAPE '\\\\' OR coalesce(description, "") LIKE ? ESCAPE '\\\\')`);
    params.push(like, like);
  }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const result = await c.env.DB.prepare(
    `SELECT * FROM tasks ${whereClause} ORDER BY due_date IS NULL, due_date ASC LIMIT ? OFFSET ?`
  ).bind(...params, limit, offset).all();
  return c.json({ data: result.results || [], pagination: { limit, offset } });
});

app.post('/tasks', async (c) => {
  const body = await parseBody(c, taskCreateSchema);
  if (body instanceof Response) return body;
  const id = crypto.randomUUID();
  const now = Date.now();
  await c.env.DB.prepare(`
    INSERT INTO tasks (
      id, user_id, visitor_id, title, description, status, priority, due_date, remind_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    body.user_id || getActorId(c),
    body.visitor_id ?? null,
    body.title,
    body.description ?? null,
    body.status || 'todo',
    body.priority || 'normal',
    body.due_date ?? null,
    body.remind_at ?? null,
    now,
    now
  ).run();
  await writeAudit(c.env, { action: 'create', resource_type: 'task', resource_id: id, changes: body, user_id: c.get('user')?.sub });
  return c.json({ id }, 201);
});

app.patch('/tasks/:id', async (c) => {
  const id = c.req.param('id');
  const body = await parseBody(c, taskUpdateSchema);
  if (body instanceof Response) return body;
  const fields: string[] = [];
  const values: any[] = [];
  for (const [k, v] of Object.entries(body)) {
    fields.push(`${k} = ?`);
    values.push(v);
  }
  if (!fields.length) return jsonError(c, 'validation_error', 'No fields to update', 400);
  fields.push('updated_at = ?');
  values.push(Date.now(), id);
  await c.env.DB.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();
  await writeAudit(c.env, { action: 'update', resource_type: 'task', resource_id: id, changes: body, user_id: c.get('user')?.sub });
  return c.json({ id });
});

app.delete('/tasks/:id', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare(`DELETE FROM tasks WHERE id = ?`).bind(id).run();
  await writeAudit(c.env, { action: 'delete', resource_type: 'task', resource_id: id, user_id: c.get('user')?.sub });
  return c.body(null, 204);
});

// Reminders CRUD
app.get('/reminders', async (c) => {
  const userId = c.req.query('user_id');
  const { limit, offset } = getPagination(c);
  const where: string[] = [];
  const params: any[] = [];
  if (userId) {
    where.push('user_id = ?');
    params.push(userId);
  }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const result = await c.env.DB.prepare(
    `SELECT * FROM reminders ${whereClause} ORDER BY remind_at ASC LIMIT ? OFFSET ?`
  ).bind(...params, limit, offset).all();
  return c.json({ data: result.results || [], pagination: { limit, offset } });
});

app.post('/reminders', async (c) => {
  const body = await parseBody(c, reminderCreateSchema);
  if (body instanceof Response) return body;
  const id = crypto.randomUUID();
  const now = Date.now();
  await c.env.DB.prepare(`
    INSERT INTO reminders (
      id, task_id, user_id, remind_at, channel, message, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    body.task_id,
    body.user_id || getActorId(c),
    body.remind_at,
    body.channel || 'in_app',
    body.message ?? null,
    now,
    now
  ).run();
  await writeAudit(c.env, { action: 'create', resource_type: 'reminder', resource_id: id, changes: body, user_id: c.get('user')?.sub });
  return c.json({ id }, 201);
});

app.patch('/reminders/:id', async (c) => {
  const id = c.req.param('id');
  const body = await parseBody(c, reminderUpdateSchema);
  if (body instanceof Response) return body;
  const fields: string[] = [];
  const values: any[] = [];
  for (const [k, v] of Object.entries(body)) {
    fields.push(`${k} = ?`);
    values.push(v);
  }
  if (!fields.length) return jsonError(c, 'validation_error', 'No fields to update', 400);
  fields.push('updated_at = ?');
  values.push(Date.now(), id);
  await c.env.DB.prepare(`UPDATE reminders SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();
  await writeAudit(c.env, { action: 'update', resource_type: 'reminder', resource_id: id, changes: body, user_id: c.get('user')?.sub });
  return c.json({ id });
});

app.delete('/reminders/:id', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare(`DELETE FROM reminders WHERE id = ?`).bind(id).run();
  await writeAudit(c.env, { action: 'delete', resource_type: 'reminder', resource_id: id, user_id: c.get('user')?.sub });
  return c.body(null, 204);
});

// Simple STT endpoint: accepts JSON { audioBase64, mimeType }
app.post('/stt', async (c) => {
  const body = await c.req.json<{ audioBase64: string; mimeType?: string }>();
  const bytes = base64ToUint8Array(body.audioBase64);
  const result = await transcribeAudio(c.env, bytes, { mimeType: body.mimeType || 'audio/wav' });
  return c.json(result);
});

// Simple TTS endpoint: accepts JSON { text, voice, format }
app.post('/tts', async (c) => {
  const body = await c.req.json<{ text: string; voice?: string; format?: 'wav' | 'mp3' | 'mulaw' | 'pcm' }>();
  const audio = await synthesizeSpeech(c.env, body.text, { voice: body.voice, format: body.format });
  return new Response(uint8ToBlob(audio, body.format || 'mp3'), {
    headers: { 'Content-Type': contentTypeForFormat(body.format || 'mp3') }
  });
});

function base64ToUint8Array(base64: string): Uint8Array {
  const binary_string = atob(base64);
  const len = binary_string.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary_string.charCodeAt(i);
  return bytes;
}

function uint8ToBlob(bytes: Uint8Array, format: string): Blob {
  const type = contentTypeForFormat(format);
  return new Blob([bytes], { type });
}

function contentTypeForFormat(format: string): string {
  switch (format) {
    case 'wav': return 'audio/wav';
    case 'mp3': return 'audio/mpeg';
    case 'mulaw': return 'audio/basic';
    case 'pcm': return 'audio/L16';
    default: return 'application/octet-stream';
  }
}

function getActorId(c: AppContext) {
  return c.get('user')?.sub || 'system';
}

function escapeLike(term: string) {
  return term.replace(/([%_\\])/g, '\\$1');
}

function getPagination(c: AppContext) {
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || String(DEFAULT_LIMIT), 10), MIN_LIMIT), MAX_LIMIT);
  const page = Math.max(parseInt(c.req.query('page') || String(MIN_PAGE), 10), MIN_PAGE);
  const offset = (page - 1) * limit;
  return { limit, offset };
}

async function parseBody<T>(c: AppContext, schema: z.ZodSchema<T>): Promise<T | Response> {
  try {
    const json = await c.req.json();
    const parsed = schema.parse(json);
    return parsed;
  } catch (err) {
    if (err instanceof ZodError) {
      return jsonError(c, 'validation_error', 'Invalid request body', 400, err.flatten());
    }
    return jsonError(c, 'validation_error', 'Invalid JSON body', 400);
  }
}

function jsonError(c: AppContext, code: string, message: string, status = 400, details?: any) {
  return c.json({ error: code, message, details }, status);
}

async function verifyJwt(token: string, secret: string): Promise<AuthUser> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed token');
  const [headerB64, payloadB64, sigB64] = parts;
  const data = `${headerB64}.${payloadB64}`;

  let header: { alg?: string; typ?: string };
  try {
    header = JSON.parse(base64UrlDecode(headerB64));
  } catch {
    throw new Error('Invalid token header');
  }
  if (header.typ && header.typ !== 'JWT') throw new Error('Invalid token type');
  if (header.alg && header.alg !== 'HS256') throw new Error('Unsupported signing algorithm');

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );

  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    base64UrlToUint8Array(sigB64),
    new TextEncoder().encode(data)
  );
  if (!valid) throw new Error('Invalid signature');

  let payload: AuthUser & { exp?: number };
  try {
    payload = JSON.parse(base64UrlDecode(payloadB64));
  } catch (e) {
    throw new Error('Invalid token payload');
  }
  if (payload.exp && Date.now() >= payload.exp * 1000) {
    throw new Error('Token expired');
  }
  return payload;
}

function base64UrlDecode(str: string): string {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const normalized = (str + pad).replace(/-/g, '+').replace(/_/g, '/');
  try {
    return atob(normalized);
  } catch (e) {
    throw new Error('Invalid base64 encoding');
  }
}

function base64UrlToUint8Array(str: string): Uint8Array {
  const binary = base64UrlDecode(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

const appointmentCreateSchema = z.object({
  user_id: z.string(),
  visitor_id: z.string().nullable().optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  type: z.string(),
  start_time: z.number().int(),
  end_time: z.number().int(),
  timezone: z.string(),
  meeting_link: z.string().url().nullable().optional(),
  location: z.string().optional(),
  attendees: z.array(z.string()).optional(),
  reminders_sent: z.array(z.number()).optional(),
  notes: z.string().optional(),
});

const appointmentUpdateSchema = appointmentCreateSchema.partial();

const visitorSchema = z.object({
  id: z.string().optional(),
  user_id: z.string().optional(),
  name: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
  source: z.string().optional(),
  lead_score: z.number().optional(),
  status: z.string().optional(),
});

const callLogSchema = z.object({
  user_id: z.string().optional(),
  visitor_id: z.string().nullable().optional(),
  call_type: z.enum(['inbound', 'outbound', 'internal']).optional(),
  direction: z.enum(['incoming', 'outgoing']).optional(),
  duration_seconds: z.number().int().optional(),
  summary: z.string().optional(),
  sentiment: z.string().optional(),
  status: z.enum(['completed', 'missed', 'busy', 'failed', 'voicemail']).optional(),
});

const messageSchema = z.object({
  visitor_id: z.string().nullable().optional(),
  channel: z.string().optional(),
  direction: z.enum(['inbound', 'outbound']).optional(),
  content: z.string().min(1),
  status: z.string().optional(),
});

const taskCreateSchema = z.object({
  user_id: z.string().optional(),
  visitor_id: z.string().nullable().optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  status: z.enum(['todo', 'in_progress', 'done', 'cancelled']).optional(),
  priority: z.enum(['low', 'normal', 'high']).optional(),
  due_date: z.number().int().nullable().optional(),
  remind_at: z.number().int().nullable().optional(),
});
const taskUpdateSchema = taskCreateSchema.partial();

const reminderCreateSchema = z.object({
  task_id: z.string(),
  user_id: z.string().optional(),
  remind_at: z.number().int(),
  channel: z.enum(['in_app', 'email', 'sms']).optional(),
  message: z.string().optional(),
});
const reminderUpdateSchema = reminderCreateSchema.partial();

export default app;
