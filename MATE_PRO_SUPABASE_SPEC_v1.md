# MATE Pro — Supabase Integration Specification
## Brief for Claude Code · v1.0 · June 2026

**Project:** Talent Mates Limited · MATE Pro (B2B product for licensed football agents)
**Repository:** `talent-mates-pddr`
**Supabase project:** `zlkzjeaojpxzccpovygk` (same project as MATE for Players, isolated by `agent_id` / `user_role`)
**Target frontend file:** `mate-pro-dashboard-v1.html` (current mock — to be wired up to real data)
**Owner:** Vitalii Lomov

---

## 0 — Read this first

This spec is the **single source of truth** for the MATE Pro backend. Treat it as the brief, not an outline. Every section is executable. If something here conflicts with what already exists in the repo, **flag it, do not silently overwrite**.

**Constraints that are not negotiable:**

1. **License gate is real.** Every row in `agents` must store an FFAR licence number. No agent account is created without one. The dashboard must reject empty licence at signup.
2. **Row Level Security is mandatory.** An agent can read and write only their own data and the clients linked to their `agent_id`. No exceptions. No "service role bypass" in client-side code.
3. **No emoji in user-facing copy.** Edge function responses, error messages, and any string returned from backend follow Edge OS voice rules: confident, quiet, precise. Race engineer tone.
4. **Sub-agent prompts (`legal`, `coach`, `analyst`, `concierge`) are sacred.** Do not modify the existing system prompts. Reuse the same prompt files from MATE for Players. The agent dashboard sends the same routed message — the difference is **context payload**, not prompt logic.
5. **Founding 100 mechanic is live from day one.** The 47th-100th agent registered is recorded. After 100 are admitted, the counter freezes and future registrations enter the regular tier.
6. **Mock data in `mate-pro-dashboard-v1.html` must be removed.** All hardcoded client cards, agent name, FFAR number, founding badge counter — replaced with live data from Supabase.

**File outputs Claude Code should produce:**

```
/supabase/migrations/202606_mate_pro_init.sql
/supabase/functions/mate-pro-chat/index.ts
/supabase/functions/mate-pro-video-analyse/index.ts
/supabase/functions/mate-pro-register/index.ts
/supabase/functions/_shared/video-frames.ts
/supabase/functions/_shared/agent-context.ts
/app.talent-mates.com/mate-pro-dashboard.html          (replaces mock v1)
/app.talent-mates.com/mate-pro-auth.html               (new — sign-in + register with FFAR field)
```

The mock dashboard stays at `/mate-pro-dashboard-v1.html` for reference. New file is the production version.

---

## 1 — Database schema

Single migration: `202606_mate_pro_init.sql`. Idempotent (safe to re-run). Uses `if not exists` clauses throughout.

### 1.1 — Tables

#### `agents`

The agent's identity, FFAR licence, and Founding 100 ranking. One row per authenticated user with `role = 'agent'`.

```sql
create table if not exists public.agents (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null unique references auth.users(id) on delete cascade,

  -- Identity
  first_name      text not null,
  last_name       text not null,
  email           text not null,

  -- FFAR licence (required at registration)
  ffar_licence    text not null,
  ffar_country    text not null,
  ffar_verified   boolean not null default false,
  ffar_verified_at timestamptz,

  -- Practice
  agency_name     text,
  country_of_operation text,
  years_experience int,
  specialisation  text,

  -- Founding 100
  founding_number int unique,                  -- 1..100, null if registered after cap
  is_founding     boolean generated always as (founding_number is not null) stored,

  -- Lifecycle
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint ffar_licence_not_empty check (length(trim(ffar_licence)) > 0)
);

create index if not exists agents_user_id_idx     on public.agents(user_id);
create index if not exists agents_founding_idx    on public.agents(founding_number) where founding_number is not null;
create index if not exists agents_ffar_idx        on public.agents(ffar_licence);
```

#### `clients`

The agent's player clients. Each client belongs to exactly one agent (the agent who entered them). No cross-agent visibility.

```sql
create type client_status as enum ('active', 'prospect', 'dormant');

create type player_position as enum (
  'Goalkeeper','Centre Back','Right Back','Left Back',
  'Defensive Midfielder','Central Midfielder','Attacking Midfielder',
  'Right Winger','Left Winger','Striker','Centre Forward'
);

create type dominant_foot as enum ('Right','Left','Both');

create table if not exists public.clients (
  id                  uuid primary key default gen_random_uuid(),
  agent_id            uuid not null references public.agents(id) on delete cascade,

  -- Identity
  first_name          text not null,
  last_name           text not null,
  date_of_birth       date,
  nationality         text,

  -- Football profile
  position_primary    player_position,
  dominant_foot       dominant_foot,
  current_club        text,
  current_league      text,
  height_cm           int,
  weight_kg           int,

  -- Contract & representation
  contract_expires    date,
  status              client_status not null default 'active',
  representation_notes text,
  commission_pct      numeric(4,2),               -- e.g. 3.00 = 3%

  -- Notes for MATE
  career_history      text,
  notes_for_mate      text,

  -- Lifecycle
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists clients_agent_id_idx on public.clients(agent_id);
create index if not exists clients_status_idx   on public.clients(agent_id, status);
```

#### `conversations`

One conversation = one chat thread. Each is linked to the agent and optionally to one client (the active client when the conversation started).

```sql
create table if not exists public.conversations (
  id              uuid primary key default gen_random_uuid(),
  agent_id        uuid not null references public.agents(id) on delete cascade,
  client_id       uuid references public.clients(id) on delete set null,

  title           text,                            -- auto-generated from first message
  sub_agent       text,                            -- 'auto' | 'legal' | 'coach' | 'analyst' | 'concierge'

  message_count   int not null default 0,
  last_message_at timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

create index if not exists conv_agent_idx  on public.conversations(agent_id, last_message_at desc);
create index if not exists conv_client_idx on public.conversations(client_id) where client_id is not null;
```

#### `messages`

Standard chat history. One row per message. Supports text + attachments (PDF and video analysis references).

```sql
create type message_role as enum ('user','assistant','system');

create table if not exists public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  agent_id        uuid not null references public.agents(id) on delete cascade,

  role            message_role not null,
  content         text not null,
  sub_agent       text,                             -- which sub-agent answered (legal/coach/analyst/concierge)

  -- Attachments
  attachment_type text,                             -- 'pdf' | 'video_analysis' | null
  attachment_ref  uuid,                             -- points to video_analyses.id when attachment_type='video_analysis'
  attachment_meta jsonb,                            -- { filename, size_bytes, ... }

  created_at      timestamptz not null default now()
);

create index if not exists messages_conv_idx  on public.messages(conversation_id, created_at);
create index if not exists messages_agent_idx on public.messages(agent_id, created_at desc);
```

#### `video_analyses`

A separate table for video analysis records — because the workload is heavy (frame extraction, vision API call) and we want to keep history independent of conversation deletes. A `messages` row may reference a `video_analyses` row via `attachment_ref`.

```sql
create type video_focus as enum ('positioning','technical','decisions','physical');
create type analysis_status as enum ('pending','extracting','analysing','complete','failed');

create table if not exists public.video_analyses (
  id              uuid primary key default gen_random_uuid(),
  agent_id        uuid not null references public.agents(id) on delete cascade,
  client_id       uuid references public.clients(id) on delete set null,
  conversation_id uuid references public.conversations(id) on delete set null,

  -- Upload
  storage_path    text not null,                    -- supabase storage path of original clip
  filename        text,
  size_bytes      int,
  duration_sec    numeric(5,2),

  -- Analysis parameters
  focus           video_focus not null default 'positioning',
  question        text,                             -- optional agent question

  -- Result
  frames_extracted int default 0,
  frame_paths     text[],                           -- storage paths of extracted frames
  result_text     text,
  status          analysis_status not null default 'pending',
  error_message   text,

  -- Lifecycle
  created_at      timestamptz not null default now(),
  completed_at    timestamptz
);

create index if not exists va_agent_idx  on public.video_analyses(agent_id, created_at desc);
create index if not exists va_client_idx on public.video_analyses(client_id) where client_id is not null;
create index if not exists va_status_idx on public.video_analyses(status) where status in ('pending','extracting','analysing');
```

#### `founding_counter` (single-row table for atomic Founding 100 assignment)

```sql
create table if not exists public.founding_counter (
  id              int primary key default 1,
  next_number     int not null default 1,
  cap             int not null default 100,
  updated_at      timestamptz not null default now(),
  constraint single_row check (id = 1)
);

insert into public.founding_counter (id, next_number, cap)
values (1, 1, 100)
on conflict (id) do nothing;
```

### 1.2 — Storage buckets

Two buckets, both **private** (no public reads):

```sql
-- Run via Supabase SQL editor after migration:
insert into storage.buckets (id, name, public)
values
  ('mate-pro-videos','mate-pro-videos', false),
  ('mate-pro-frames','mate-pro-frames', false)
on conflict (id) do nothing;
```

**Storage RLS policies** (run in SQL editor):

```sql
-- Agents can read/write only files inside their own folder: agent_id/...
create policy "agents read own videos"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'mate-pro-videos'
    and (storage.foldername(name))[1] = (select id::text from public.agents where user_id = auth.uid())
  );

create policy "agents insert own videos"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'mate-pro-videos'
    and (storage.foldername(name))[1] = (select id::text from public.agents where user_id = auth.uid())
  );

create policy "agents delete own videos"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'mate-pro-videos'
    and (storage.foldername(name))[1] = (select id::text from public.agents where user_id = auth.uid())
  );

-- Identical policies for mate-pro-frames bucket
create policy "agents read own frames"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'mate-pro-frames'
    and (storage.foldername(name))[1] = (select id::text from public.agents where user_id = auth.uid())
  );

create policy "service role writes frames"
  on storage.objects for insert to service_role
  with check (bucket_id = 'mate-pro-frames');
```

File path convention:

```
mate-pro-videos / {agent_id} / {video_analysis_id}.mp4
mate-pro-frames / {agent_id} / {video_analysis_id} / frame_001.jpg
mate-pro-frames / {agent_id} / {video_analysis_id} / frame_002.jpg
```

### 1.3 — Row Level Security

Enable RLS on every table:

```sql
alter table public.agents enable row level security;
alter table public.clients enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.video_analyses enable row level security;
alter table public.founding_counter enable row level security;
```

Policies:

```sql
-- ── agents ──
create policy "agent reads own row"
  on public.agents for select to authenticated
  using (user_id = auth.uid());

create policy "agent updates own row"
  on public.agents for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Insert handled by mate-pro-register edge function (service role), not direct insert

-- ── clients ──
create policy "agent reads own clients"
  on public.clients for select to authenticated
  using (agent_id = (select id from public.agents where user_id = auth.uid()));

create policy "agent inserts own clients"
  on public.clients for insert to authenticated
  with check (agent_id = (select id from public.agents where user_id = auth.uid()));

create policy "agent updates own clients"
  on public.clients for update to authenticated
  using (agent_id = (select id from public.agents where user_id = auth.uid()));

create policy "agent deletes own clients"
  on public.clients for delete to authenticated
  using (agent_id = (select id from public.agents where user_id = auth.uid()));

-- ── conversations ──
create policy "agent reads own conversations"
  on public.conversations for select to authenticated
  using (agent_id = (select id from public.agents where user_id = auth.uid()));

create policy "agent writes own conversations"
  on public.conversations for all to authenticated
  using (agent_id = (select id from public.agents where user_id = auth.uid()))
  with check (agent_id = (select id from public.agents where user_id = auth.uid()));

-- ── messages ──
create policy "agent reads own messages"
  on public.messages for select to authenticated
  using (agent_id = (select id from public.agents where user_id = auth.uid()));

create policy "agent writes own messages"
  on public.messages for insert to authenticated
  with check (agent_id = (select id from public.agents where user_id = auth.uid()));

-- ── video_analyses ──
create policy "agent reads own video analyses"
  on public.video_analyses for select to authenticated
  using (agent_id = (select id from public.agents where user_id = auth.uid()));

create policy "agent inserts own video analyses"
  on public.video_analyses for insert to authenticated
  with check (agent_id = (select id from public.agents where user_id = auth.uid()));

-- Updates to video_analyses come from edge function (service role)

-- ── founding_counter ──
create policy "everyone reads founding counter"
  on public.founding_counter for select to authenticated
  using (true);

-- Updates only via edge function (service role)
```

### 1.4 — Functions and triggers

#### Auto-update `updated_at`

```sql
create or replace function public.touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger trg_agents_touch  before update on public.agents
  for each row execute function public.touch_updated_at();

create trigger trg_clients_touch before update on public.clients
  for each row execute function public.touch_updated_at();
```

#### Atomic Founding 100 number assignment

Called by the register edge function. Returns the assigned number or `null` if cap reached.

```sql
create or replace function public.assign_founding_number()
returns int as $$
declare
  assigned int;
begin
  update public.founding_counter
    set next_number = next_number + 1,
        updated_at = now()
    where id = 1
      and next_number <= cap
    returning next_number - 1 into assigned;

  return assigned;  -- null if already past cap
end;
$$ language plpgsql security definer;

grant execute on function public.assign_founding_number() to service_role;
```

#### Conversation message counter

```sql
create or replace function public.bump_conversation_counter()
returns trigger as $$
begin
  update public.conversations
    set message_count = message_count + 1,
        last_message_at = new.created_at
    where id = new.conversation_id;
  return new;
end;
$$ language plpgsql;

create trigger trg_msg_bump_conv
  after insert on public.messages
  for each row execute function public.bump_conversation_counter();
```

---

## 2 — Edge functions

Three functions, written in TypeScript for Deno (Supabase edge runtime).

### 2.1 — `mate-pro-register`

**Purpose:** Atomic registration flow. Creates the auth user (if not already), inserts agents row, assigns Founding 100 number.

**Why an edge function, not direct insert:** Founding 100 assignment must be atomic and run with service role. Client cannot be trusted to claim numbers.

**Endpoint:** `POST /functions/v1/mate-pro-register`

**Request body:**

```typescript
{
  email: string;
  password: string;              // min 8 chars
  first_name: string;
  last_name: string;
  ffar_licence: string;          // required, non-empty
  ffar_country: string;          // required (FIFA member nation from dropdown)
}
```

**Profile fields** (`agency_name`, `country_of_operation`, `years_experience`, `specialisation`) are **not collected at registration**. They remain nullable in the `agents` schema and are filled later via the Agent Profile modal in the dashboard. Registration is intentionally minimal — six fields, one screen, no scroll on mobile.

**Response (200):**

```typescript
{
  agent_id: string;
  founding_number: number | null;  // null if cap of 100 already reached
  is_founding: boolean;
  session: { access_token: string; refresh_token: string };
}
```

**Response (4xx):**

```typescript
{ error: string; field?: string }
```

**Validation rules:**

- `email` valid format, not already registered
- `password` minimum 8 chars
- `first_name`, `last_name` non-empty, max 100 chars each
- `ffar_licence` non-empty after trim, max 50 chars
- `ffar_country` must match one of FIFA member nations (use a fixed enum list — include all 211 FIFA member associations as of 2026; Claude Code should generate this list from `https://www.fifa.com/member-associations` or use a static constant)

**Do not validate FFAR format** (FFAR-2024-UA-XXXX or similar) — the format varies by national federation. Trust agents to enter their own licence correctly. Verification happens server-side later (out of scope for v1).

**Flow:**

1. Validate request body. Return 400 with `{error, field}` on failure.
2. `supabase.auth.admin.createUser({ email, password, email_confirm: true })`. If email exists, return 409.
3. Call `assign_founding_number()` RPC. Receive `founding_number` (int or null).
4. Insert into `agents` with all fields + `founding_number`.
5. Sign user in (`auth.signInWithPassword`) to return session.
6. Return 200 with agent_id, founding_number, session.

**Critical:** wrap insert + auth user creation in a try/catch. If the agents insert fails, **delete the auth user** so the email is not orphaned. Otherwise the user can never re-register.

---

### 2.2 — `mate-pro-chat`

**Purpose:** Send a chat message. Reuses the existing four sub-agent prompts from MATE for Players. The difference is the **context payload** — an agent message carries client context.

**Endpoint:** `POST /functions/v1/mate-pro-chat`

**Request body:**

```typescript
{
  conversation_id?: string;     // null on first message of new conversation
  client_id?: string;           // active client (may be null for general queries)
  sub_agent: 'auto'|'legal'|'coach'|'analyst'|'concierge';
  message: string;
  attachment?: {
    type: 'pdf';
    storage_path: string;       // already uploaded to mate-pro-videos? no — to a separate pdf bucket if you have one, or include base64 inline for small files
    filename: string;
  };
}
```

**Response (200, streaming):**

Standard Server-Sent Events stream of assistant tokens, terminated by `data: [DONE]`.

**Auth:** Bearer token (auth.uid → agents row). Derive `agent_id` server-side. Never trust client-sent agent_id.

**Flow:**

1. Verify auth, look up `agent_id` from `user_id`.
2. If `conversation_id` is null, create a new row in `conversations` with `agent_id`, `client_id`, `sub_agent`. Set provisional `title` = first 60 chars of message.
3. Insert user message row in `messages`.
4. Build context payload:
   - **Agent context** — pulled from `agents`: name, agency, country, years_experience, specialisation
   - **Client context** — if `client_id` provided, pull full client row including `career_history` and `notes_for_mate`
   - **Recent conversation history** — last 20 messages from this conversation
5. Determine which sub-agent prompt to load:
   - If `sub_agent === 'auto'` — run lightweight router (existing logic from MATE for Players) to choose Legal / Coach / Analyst / Concierge
   - Else use the explicitly selected sub-agent
6. Call Anthropic API with the existing sub-agent system prompt (unchanged) + agent context block + client context block + recent history + new message.
7. Stream response back. After completion, insert assistant message row with the sub-agent that answered.

**Context block format** (prepended to the existing system prompt — do not modify the existing prompts themselves):

```
<agent_context>
You are speaking with a licensed football agent.
Name: {agent.first_name} {agent.last_name}
Agency: {agent.agency_name}
Country of operation: {agent.country_of_operation}
Years of experience: {agent.years_experience}
Specialisation: {agent.specialisation}
FFAR licensed and verified.

Voice mode for this audience: speak to them as a peer professional. Do not explain basic regulations they already know. Get to insight quickly. Treat them as race engineer collaborator, not as protected end-user.
</agent_context>

<client_context>
Currently working on:
Name: {client.first_name} {client.last_name}
Age: {derived from date_of_birth}
Position: {client.position_primary}, {client.dominant_foot}-footed
Current club: {client.current_club}, {client.current_league}
Contract expires: {client.contract_expires}
Status with this agent: {client.status}
Representation: {client.representation_notes}
Career history: {client.career_history}
Notes for MATE: {client.notes_for_mate}
</client_context>
```

If no client selected, omit `<client_context>` and add `<no_client_active>The agent has not selected a specific client. Treat this as a general or prospecting query.</no_client_active>`.

---

### 2.3 — `mate-pro-video-analyse`

**Purpose:** Process a video clip — extract frames, send to Claude vision, return scout's read as a message in the agent's conversation.

**Endpoint:** `POST /functions/v1/mate-pro-video-analyse`

**Request body:**

```typescript
{
  conversation_id?: string;        // optional — if provided, result becomes a message in this conversation
  client_id?: string;
  storage_path: string;             // path of uploaded video in mate-pro-videos bucket
  filename: string;
  focus: 'positioning'|'technical'|'decisions'|'physical';
  question?: string;
}
```

**Response (200):**

```typescript
{
  video_analysis_id: string;
  status: 'complete'|'failed';
  result_text?: string;
  message_id?: string;              // if a message was inserted into the conversation
  error?: string;
}
```

**Important:** This endpoint can take 15-45 seconds (frame extraction + vision API). Set Supabase function timeout to 60s. Return SSE progress events:

```
event: status
data: {"status":"extracting","frames_done":0}

event: status
data: {"status":"extracting","frames_done":4}

event: status
data: {"status":"analysing"}

event: result
data: {"status":"complete","result_text":"...","video_analysis_id":"..."}
```

**Flow:**

1. Verify auth, derive `agent_id`.
2. Insert `video_analyses` row with status `pending`, store metadata.
3. Set status to `extracting`. Run frame extraction (see `_shared/video-frames.ts` below).
4. Upload extracted frames to `mate-pro-frames/{agent_id}/{video_analysis_id}/`.
5. Update row with `frame_paths`, set status to `analysing`.
6. Build vision API call:
   - System prompt: load the Coach sub-agent prompt unchanged (the Coach already understands football reading)
   - Add a video-analysis modifier block (see "Vision modifier block" below)
   - Pass frames as base64-encoded images via the Anthropic vision API
   - Include client context if available
7. Receive response, store in `result_text`, set status to `complete`.
8. If `conversation_id` provided: insert a `messages` row with `role='assistant'`, `content=result_text`, `attachment_type='video_analysis'`, `attachment_ref=video_analyses.id`.
9. Return final SSE event.

**Vision modifier block** (added on top of the Coach system prompt for video analyses):

```
<video_analysis_brief>
You are reading a short football clip via 8-12 extracted key frames. You are not analysing live footage and you do not measure quantitative metrics. You describe what is visible to a trained eye — body shape, positioning, technical execution in the moment, decisions taken with the alternatives that were available, and the visible physical profile.

The agent has asked you to focus on: {focus}.

You write a scout's read — the kind a Cat 1 academy scout would file after watching a clip. Structure your output:

1. One-sentence summary of what the clip shows.
2. Focus area read (the requested focus).
3. One thing that would interest a club at the level the client is targeting.
4. One thing that would concern a recruiter at that level.
5. One specific question the agent should investigate next.

Do not pad. Do not list bullets longer than necessary. The agent is reading this on a phone between meetings.
</video_analysis_brief>
```

If the agent provided a `question`, append it: `<agent_question>{question}</agent_question>`.

---

## 3 — Frame extraction module

File: `/supabase/functions/_shared/video-frames.ts`

The Supabase Edge runtime is Deno, not Node. FFmpeg is available via WASM build. **Use `@diffusion-studio/ffmpeg-js` or `ffmpeg.wasm` — confirm latest stable Deno-compatible package before installing.**

**Strategy:**

1. Download video from `mate-pro-videos` bucket (signed URL or direct service-role read)
2. Inspect duration via ffprobe (also available in wasm build)
3. Extract N frames evenly distributed across the clip duration
   - For clips ≤ 10s: extract 6 frames
   - For 10–30s: extract 8 frames
   - For 30–60s: extract 10 frames
   - Reject clips > 60s with clear error message
4. Output JPEG, 1280px wide, quality 80 (this balances vision API cost and detail)
5. Return array of frame buffers (or upload directly to frames bucket and return paths)

**Module signature:**

```typescript
export async function extractFrames(params: {
  videoPath: string;                         // storage path
  videoAnalysisId: string;
  agentId: string;
  supabase: SupabaseClient;
  onProgress?: (framesDone: number) => void;
}): Promise<{
  frames: { path: string; index: number }[];
  durationSec: number;
}>
```

**Performance note for Claude Code:** Deno edge functions have a 50MB memory ceiling and 60s execution limit. If frame extraction proves too heavy in edge environment, fallback option is a Supabase background job using `pg_cron` + a dedicated worker. Start with edge function; escalate only if memory/time becomes a problem in practice.

**Fallback if ffmpeg-wasm is problematic:** A simpler approach that works today is to do frame extraction client-side in the browser using `<video>` + canvas before upload. The browser already has the decoder. The frontend extracts 8-10 frames as JPEGs, uploads them to `mate-pro-frames` bucket, and the edge function only handles the vision API call. **Recommend trying this first** — it removes ffmpeg complexity entirely. The frontend mock already has a placeholder for this in `runVideoAnalysis()`.

If you choose client-side extraction, document the decision and update the request body of `mate-pro-video-analyse` to accept `frame_paths: string[]` instead of `storage_path`.

---

## 4 — Frontend — `mate-pro-dashboard.html`

Start from `mate-pro-dashboard-v1.html`. Make these changes:

### 4.1 — Replace mock data with live queries

Remove the hardcoded `clients` object at the top of the script. Replace with:

```javascript
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let state = {
  agent: null,                         // loaded on init
  clients: [],                         // loaded on init
  selectedClientId: null,
  selectedSubAgent: 'auto',
  selectedConversationId: null,
  conversations: [],                   // for sidebar history
};

async function init() {
  // 1. Check auth
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { window.location.href = 'mate-pro-auth.html'; return; }

  // 2. Load agent
  const { data: agent, error: agentErr } = await sb
    .from('agents')
    .select('*')
    .eq('user_id', session.user.id)
    .single();
  if (agentErr || !agent) { window.location.href = 'mate-pro-auth.html'; return; }
  state.agent = agent;

  // 3. Load clients
  const { data: clients } = await sb
    .from('clients')
    .select('*')
    .eq('agent_id', agent.id)
    .order('status', { ascending: true })
    .order('created_at', { ascending: false });
  state.clients = clients ?? [];

  // 4. Pick first active client as default
  const firstActive = state.clients.find(c => c.status === 'active') ?? state.clients[0];
  state.selectedClientId = firstActive?.id ?? null;

  // 5. Load conversations for sidebar
  const { data: convs } = await sb
    .from('conversations')
    .select('*, clients(first_name, last_name)')
    .eq('agent_id', agent.id)
    .order('last_message_at', { ascending: false })
    .limit(30);
  state.conversations = convs ?? [];

  // 6. Render everything
  renderAgentIdentity();
  renderRosterStrip();
  renderConversationHistory();
  renderWelcomePrompts();
}
```

### 4.2 — Functions to implement

Each function below replaces equivalent mock logic in v1:

- `renderAgentIdentity()` — fills stats bar (FFAR, agency, country, roster count), founding badge, sidebar footer, profile modal defaults
- `renderRosterStrip()` — renders client cards from `state.clients`. First active client is selected by default. Empty state shows "Add your first client" if `clients.length === 0`
- `renderConversationHistory()` — fills sidebar with conversations grouped by Today / Yesterday / Last week (use `last_message_at`)
- `renderWelcomePrompts()` — already exists in v1, keep the dynamic template substitution
- `selectClient(el, clientId)` — same as v1 but also reloads conversations filtered for that client (optional — discuss with founder)
- `saveNewClient()` — inserts into `clients` table. On success, prepend new card to roster strip
- `saveAgentProfile()` — updates `agents` row
- `sendMessage()` — calls `mate-pro-chat` edge function with SSE streaming
- `runVideoAnalysis()` — uploads file to `mate-pro-videos`, then calls `mate-pro-video-analyse` edge function with SSE progress

### 4.3 — Auth page

New file `mate-pro-auth.html`. Inside Shell aesthetic (purple background, glass-morphic card), single viewport on mobile (no scroll on iPhone 14 / 390×844). Two tabs: **Sign in** and **Request access**.

**Tab labels are deliberate:** *"Request access"* — not *"Sign up"*, not *"Create account"*. This phrasing reinforces the velvet rope position. The agent feels they are applying to enter a professional community, not signing up to another SaaS.

#### Sign in tab

Two fields only:
- Email
- Password

CTA: *"Sign in"*. Below: small link *"Forgot password?"* → triggers `auth.resetPasswordForEmail` and shows a quiet inline confirmation.

Below the form: small text *"Don't have access yet?"* → links to the Request access tab.

Optional but recommended: *"Send me a magic link"* secondary action below the password field. Uses `auth.signInWithOtp({ email })`. Reduces friction for returning users without compromising the professional feel of password auth on initial setup.

#### Request access tab — minimal form

**Exactly six fields. No more. No less.**

```
Row 1 (two columns on desktop, stacked on mobile):
  First name           Last name
  [text input]         [text input]

Row 2:
  Email
  [email input]

Row 3:
  Password
  [password input]
  Helper text: "Minimum 8 characters."

Row 4 (two columns on desktop, stacked on mobile):
  FFAR licence number  Country of licence issue
  [text input]         [dropdown — FIFA member nations]

CTA button (white pill, full width):
  Request access

Fine print below button:
  By requesting access you agree to our Terms and Privacy Policy.
```

**Country dropdown:** populated from a static constant of all 211 FIFA member associations as of 2026 (Albania → Zimbabwe). Default state is empty placeholder *"Select country"* — no pre-selection. Do not assume the agent's country from IP or browser locale; we want the explicit choice for compliance accuracy.

#### Field validation behaviour

- Inline validation on blur, not on every keystroke
- Error messages appear below the field in `var(--accent-red)` (define as `#ff9898` — already used in modal-msg.error)
- The Request access button is enabled only when all six fields are non-empty (client-side check). Server-side validation is the authority.

#### Submit flow

1. Disable the button, show inline spinner.
2. Call `mate-pro-register` edge function with the six fields.
3. On 200: store the returned session via `supabase.auth.setSession()`, redirect to `/mate-pro-dashboard.html?founding={number}` (or just `/mate-pro-dashboard.html` if `founding_number` is null).
4. On 4xx: display server error message in the modal-msg area below the button. Specific handling:
   - `409 email exists` → *"This email is already registered. Sign in or use a different email."*
   - `400 ffar_licence missing` → *"FFAR licence number is required."*
   - any other → show the server error string as-is

#### Welcome state on first dashboard load

If the URL has `?founding=N` where N ≤ 100:

Show a one-time toast or top banner: *"Welcome, Founding Agent #{N}. Lifetime price lock at €149/month. Direct founder access."*

If `founding_number` is null (registered after cap):

Show: *"Welcome to MATE Pro. The Founding 100 cohort is complete — your account is on the standard tier."*

The banner appears once per session and dismisses on first interaction with the dashboard.

### 4.4 — Founding 100 counter — live, not hardcoded

The `#47` in the topbar must be read from `state.agent.founding_number`. If the agent is not founding (registered after cap), the badge is hidden.

Optionally: small public read on every dashboard load — show current `next_number - 1` as "X of 100 admitted" somewhere visible. Creates urgency for prospects who haven't completed signup yet. Discuss with founder before adding.

---

## 5 — Migration plan

This is the order of operations. **Do not skip steps.**

1. **Branch.** `git checkout -b feat/mate-pro-backend`
2. **Migration.** Run `supabase migration new mate_pro_init`, paste the SQL from Section 1. Verify it applies cleanly to a local Supabase first (`supabase start` + `supabase db reset`). Do not push to remote yet.
3. **Storage buckets and policies.** Run the storage SQL from Section 1.2 manually in the Supabase Studio SQL editor of the local instance. Verify the buckets exist and policies are applied.
4. **Edge function: register.** Build, test locally with `supabase functions serve`. Use the Supabase Studio to attempt registration with a test email + FFAR licence. Verify `founding_number` increments atomically across rapid successive registrations.
5. **Edge function: chat.** Build, test locally. Send a test message with and without a client context. Verify the existing sub-agent prompts are loaded **unchanged**.
6. **Edge function: video-analyse.** Build with client-side frame extraction first (frontend extracts → uploads → edge function reads from storage). Test with one short clip end-to-end before moving on.
7. **Frontend rewire.** Take `mate-pro-dashboard-v1.html`, save as `mate-pro-dashboard.html`, replace mock data with live queries. Test the full flow against local Supabase.
8. **Push to remote.** `supabase db push`. Verify migrations applied. Deploy edge functions: `supabase functions deploy mate-pro-register mate-pro-chat mate-pro-video-analyse`.
9. **Smoke test in production.** Register a real test account (use your own founder account with FFAR-2024-UA-0847). Verify `founding_number` is assigned. Send a test message. Run a test video analysis.
10. **Hand off to Vitalii for QA.** Provide a checklist (see Section 7 below).

**Do not push to production without going through steps 1-8 in order.**

---

## 6 — Environment variables required

In `/supabase/functions/.env` (local) and the Supabase Studio environment variables for production:

```
ANTHROPIC_API_KEY=sk-ant-...
SUPABASE_URL=https://zlkzjeaojpxzccpovygk.supabase.co
SUPABASE_ANON_KEY=...                     # already exists
SUPABASE_SERVICE_ROLE_KEY=...              # already exists
MATE_PRO_MODEL=claude-opus-4-7            # or whichever is current production model
MATE_PRO_VISION_MODEL=claude-opus-4-7     # same model — vision is built-in
```

Use the same `ANTHROPIC_API_KEY` as the existing `mate-chat` function. Do not create a separate one.

---

## 7 — Vitalii's QA checklist

Hand this to Vitalii when the work is done. Each item must pass before MATE Pro is shown to the first beta agent.

### Registration

- [ ] I can register a new account at `/mate-pro-auth.html` with valid email + FFAR licence
- [ ] Registration without FFAR licence is rejected with a clear error
- [ ] After registration, I land on the dashboard with my Founding Agent number displayed
- [ ] Logging out and logging back in preserves my agent data

### Roster

- [ ] I can add a new client via the Client Roster modal
- [ ] The new client appears immediately in the Roster Strip
- [ ] Switching active client updates: stats bar (no — that's agent stats), context line, input placeholder, welcome subtitle, all four welcome prompts
- [ ] I can edit and delete clients
- [ ] I see only my clients — not those of other agents (test with a second account if needed)

### Chat

- [ ] I can send a message with no client selected — MATE responds as a general professional query
- [ ] I can send a message with a client selected — MATE references the client by name and context in the response
- [ ] Sub-agent routing (Auto / Legal / Coach / Analyst / Concierge) works as expected
- [ ] Conversation history appears in the sidebar with the correct client tag
- [ ] Returning to a past conversation loads it and lets me continue

### Video analysis

- [ ] I can upload a 10-30 second video clip
- [ ] Frame extraction succeeds and I see progress updates
- [ ] The Coach returns a structured scout's read in the chat
- [ ] The result is correctly attached to the right client in the right conversation

### Security

- [ ] If I copy another agent's ID into a request, I cannot read their data
- [ ] If I copy a video URL from another agent's video, I get a 403
- [ ] FFAR licence is stored as plain text and visible in my agent profile

### Voice

- [ ] No emoji appear in any backend-generated string (error messages, system replies, edge function responses)
- [ ] The race engineer tone holds across all sub-agent responses
- [ ] No "Hi there!" / "Sure!" / "I'd love to help!" patterns appear in responses

---

## 8 — What is out of scope for this delivery

Listed so Claude Code does not drift:

- FIFA registry automated verification (live API call to agents.fifa.com) — manual `ffar_verified` flag for now
- Stripe billing integration — comes in a separate sprint
- MATE Pro Verified tier (€499) and Agency tier (€999) — gating logic comes later
- Live transcription of video audio — V1 reads visual frames only, ignores audio
- Multi-agent agencies — one user = one agent for now
- LinkedIn / email outbound integration — separate sprint
- Public Founding 100 counter on landing page — that's a landing page job, not a dashboard job
- Mobile app — web responsive only at this stage

---

## 9 — Open questions for Vitalii (resolve before starting)

These are decisions only Vitalii makes. Claude Code should pause and ask if any of these is unclear:

1. **Do existing MATE for Players users share the same `auth.users` table?** If yes, we need a `role` flag (`'player' | 'agent'`) on something — could be a custom claim, a row in a `user_profiles` table, or a check via existence in `players` vs `agents`. The auth pages need to route correctly.
2. **Sub-agent prompt files location.** Where are the existing Legal / Coach / Analyst / Concierge system prompts stored? In the `mate-chat` edge function? In Supabase as rows? In a config file? **Claude Code must read them unchanged**, not rewrite them.
3. **PDF analysis flow.** The agent dashboard has a PDF upload button. For MATE Pro, does it follow the same flow as MATE for Players? If so, point Claude Code at the existing implementation. If different, specify.
4. **Conversation history filtering by client.** When the agent switches active client, should the sidebar history filter to only that client's conversations, or show all? Vitalii's call.

---

## 10 — Success definition

The MATE Pro backend is complete when:

1. A new agent can register with a FFAR licence and become Founding Agent #N (N ≤ 100, atomic).
2. The agent can add clients, switch between them, and the entire UI follows the active client.
3. The agent can send a chat message and receive a race-engineer-toned response from the routed sub-agent, with full client context loaded into the prompt.
4. The agent can upload a short video clip, get a structured scout's read from the Coach sub-agent, and see it persisted in their conversation history.
5. No cross-agent data leakage. RLS enforces isolation under any attack vector.
6. All four MATE for Players sub-agent prompts are reused **unchanged** for MATE Pro.
7. The frontend is fully wired to live Supabase data — no mock objects remain in the production HTML file.

When all seven hold, MATE Pro is ready for tiha beta with the first 10 agents in Vitalii's warm network.

---

## Final word for Claude Code

This is the spec. Build cleanly. Push back if anything in here makes no sense — do not silently work around it. Vitalii's preference is **quality and correctness over speed**. If something will take an extra day to do right, take the day.

The four sub-agent prompts are sacred. The FFAR licence gate is non-negotiable. The race engineer voice does not bend. Everything else is engineering.

**MATE doesn't play. MATE prepares the ones who do.**

— Mate
