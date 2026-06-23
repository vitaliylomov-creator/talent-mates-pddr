-- ════════════════════════════════════════════════════════════════════════════
-- MATE Pro · Storage migration 0006 — buckets + storage RLS
-- ════════════════════════════════════════════════════════════════════════════
--
-- Target project:  Mate AI Supabase (zlkzjeaojpxzccpovygk · eu-central-1)
-- Apply via:       Supabase Dashboard → SQL Editor → paste → Run
-- Depends on:      0005_mate_pro_init.sql (needs public.mate_pro_agents)
--
-- What this file does
-- ───────────────────
--   1. Creates two private storage buckets:
--        - mate-pro-videos   uploaded original clips
--        - mate-pro-frames   extracted JPEG key frames
--   2. Attaches storage.objects RLS policies so each agent can only
--      read/write under their own folder: {agent_id}/...
--   3. Frames bucket: insert restricted to service_role only (frames
--      are produced by the mate-pro-video-analyse edge function).
--
-- File path convention (spec §1.2)
-- ────────────────────────────────
--   mate-pro-videos / {agent_id} / {video_analysis_id}.mp4
--   mate-pro-frames / {agent_id} / {video_analysis_id} / frame_001.jpg
--
-- Bucket name format
-- ──────────────────
-- Bucket IDs allow dashes but not underscores in some Supabase tooling
-- paths, so we keep dashes here (mate-pro-videos) even though the
-- table prefix uses underscores (mate_pro_videos would be a table).
--
-- Idempotency
-- ───────────
-- Bucket inserts use ON CONFLICT DO NOTHING. Policies are DROPped
-- before CREATE so re-applying is safe.
--
-- ════════════════════════════════════════════════════════════════════════════

-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 1 — Buckets
-- ════════════════════════════════════════════════════════════════════════════

INSERT INTO storage.buckets (id, name, public)
VALUES
  ('mate-pro-videos', 'mate-pro-videos', false),
  ('mate-pro-frames', 'mate-pro-frames', false)
ON CONFLICT (id) DO NOTHING;


-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 2 — mate-pro-videos RLS
-- ════════════════════════════════════════════════════════════════════════════
-- Agents read/write/delete files only under their own agent_id folder.
-- The folder check uses storage.foldername(name)[1] which gives the
-- first path segment as text — we compare to the agent's UUID cast
-- to text. The subselect resolves auth.uid() → mate_pro_agents.id.

DROP POLICY IF EXISTS mate_pro_videos_select_own ON storage.objects;
CREATE POLICY mate_pro_videos_select_own
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'mate-pro-videos'
    AND (storage.foldername(name))[1] = (
      SELECT id::text FROM public.mate_pro_agents WHERE user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS mate_pro_videos_insert_own ON storage.objects;
CREATE POLICY mate_pro_videos_insert_own
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'mate-pro-videos'
    AND (storage.foldername(name))[1] = (
      SELECT id::text FROM public.mate_pro_agents WHERE user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS mate_pro_videos_delete_own ON storage.objects;
CREATE POLICY mate_pro_videos_delete_own
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'mate-pro-videos'
    AND (storage.foldername(name))[1] = (
      SELECT id::text FROM public.mate_pro_agents WHERE user_id = auth.uid()
    )
  );


-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 3 — mate-pro-frames RLS
-- ════════════════════════════════════════════════════════════════════════════
-- Agents can READ their own frames (for re-display in chat history).
-- Inserts/deletes are service-role only because frames are produced
-- by the mate-pro-video-analyse edge function.
--
-- NOTE on client-side frame extraction path
-- ─────────────────────────────────────────
-- If frame extraction is performed in the browser (recommended in
-- spec §3 fallback), the frontend uploads frames itself. In that
-- case we need an INSERT policy for authenticated users too. We
-- add it commented out below — uncomment when client-side path
-- is finalised.

DROP POLICY IF EXISTS mate_pro_frames_select_own ON storage.objects;
CREATE POLICY mate_pro_frames_select_own
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'mate-pro-frames'
    AND (storage.foldername(name))[1] = (
      SELECT id::text FROM public.mate_pro_agents WHERE user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS mate_pro_frames_insert_service ON storage.objects;
CREATE POLICY mate_pro_frames_insert_service
  ON storage.objects FOR INSERT TO service_role
  WITH CHECK (bucket_id = 'mate-pro-frames');

-- Browser-side frame extraction (Step 6 decision): the dashboard's
-- runVideoAnalysis() draws frames from <video> to canvas, JPEG-encodes,
-- and uploads each to mate-pro-frames/{agent_id}/{video_analysis_id}/.
-- The mate-pro-video-analyse edge function then reads them as service_role.

DROP POLICY IF EXISTS mate_pro_frames_insert_own ON storage.objects;
CREATE POLICY mate_pro_frames_insert_own
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'mate-pro-frames'
    AND (storage.foldername(name))[1] = (
      SELECT id::text FROM public.mate_pro_agents WHERE user_id = auth.uid()
    )
  );

-- Delete-own is also needed so the dashboard can clean up extracted
-- frames after a successful analysis (or when retrying a failed one).
-- Service-role bypasses RLS — this only governs browser-initiated deletes.
DROP POLICY IF EXISTS mate_pro_frames_delete_own ON storage.objects;
CREATE POLICY mate_pro_frames_delete_own
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'mate-pro-frames'
    AND (storage.foldername(name))[1] = (
      SELECT id::text FROM public.mate_pro_agents WHERE user_id = auth.uid()
    )
  );

-- ════════════════════════════════════════════════════════════════════════════
-- End of migration 0006_mate_pro_storage.sql
-- ════════════════════════════════════════════════════════════════════════════
