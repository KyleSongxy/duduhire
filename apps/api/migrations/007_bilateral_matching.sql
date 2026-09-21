-- A publication is a separate, explicitly consented snapshot. Discovery drafts
-- never enter the catalog automatically, including when they are confirmed.
CREATE TABLE matching_listings (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('problem', 'capability')),
  source_thread_id uuid NOT NULL,
  source_thread_version integer NOT NULL CHECK (source_thread_version > 0),
  source_artifact_version integer NOT NULL CHECK (source_artifact_version > 0),
  status text NOT NULL CHECK (status IN ('published', 'withdrawn')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  title text NOT NULL CHECK (char_length(title) BETWEEN 2 AND 60),
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 10 AND 500),
  skills text[] NOT NULL CHECK (cardinality(skills) BETWEEN 1 AND 8),
  required_skills text[] NOT NULL DEFAULT '{}' CHECK (cardinality(required_skills) <= 8 AND required_skills <@ skills),
  work_mode text NOT NULL CHECK (work_mode IN ('any', 'remote', 'onsite', 'hybrid')),
  engagement text NOT NULL CHECK (engagement IN ('any', 'project', 'part_time', 'full_time')),
  location text NOT NULL DEFAULT '' CHECK (char_length(location) <= 60),
  notes text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 200),
  consented_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (owner_user_id, kind),
  FOREIGN KEY (source_thread_id, kind) REFERENCES discovery_threads(id, kind) ON DELETE CASCADE,
  CHECK (kind = 'problem' OR cardinality(required_skills) = 0),
  CHECK (skills <@ ARRAY['需求分析', '流程自动化', '知识库', '智能问答', '数据分析', '数据可视化',
    '产品设计', 'UI设计', '前端开发', '后端开发', '系统集成', '测试验收',
    '内容创作', '市场营销', '客户服务', '人力资源', '财务流程', '项目管理']::text[]),
  CHECK (work_mode NOT IN ('onsite', 'hybrid') OR char_length(btrim(location)) > 0),
  CHECK (consented_at <= updated_at),
  CHECK (updated_at >= created_at)
);

CREATE INDEX matching_listings_published_kind_idx
  ON matching_listings (kind, updated_at DESC, id)
  WHERE status = 'published';
CREATE INDEX matching_listings_published_skills_idx
  ON matching_listings USING gin (skills)
  WHERE status = 'published';

REVOKE ALL ON TABLE matching_listings FROM PUBLIC;
