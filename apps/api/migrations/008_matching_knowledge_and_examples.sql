-- Extend the controlled job vocabulary without changing any existing listings.
DO $migration$
DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'matching_listings'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%需求分析%'
  LOOP
    EXECUTE format('ALTER TABLE matching_listings DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END
$migration$;

ALTER TABLE matching_listings ADD CONSTRAINT matching_listings_allowed_skills CHECK (
  skills <@ ARRAY['需求分析', '流程自动化', '知识库', '智能问答', '数据分析', '数据可视化',
    '产品设计', 'UI设计', '前端开发', '后端开发', '系统集成', '测试验收',
    '内容创作', '市场营销', '客户服务', '人力资源', '财务流程', '项目管理',
    'RAG检索', 'AI智能体', '提示词设计', '模型评估', '模型微调', '数据治理', '模型部署',
    '海外市场调研', '出海策略', '海外获客', '广告投放', 'SEO优化', '内容本地化', '跨境电商', '渠道拓展', '跨境运营']::text[]
);
ALTER TABLE matching_listings ADD COLUMN constraints jsonb;
ALTER TABLE matching_listings ADD CONSTRAINT matching_constraints_object
  CHECK (constraints IS NULL OR jsonb_typeof(constraints) = 'object');

-- Examples have no owner, account, contact, publication or discovery identity.
-- They can only be served by the explicitly labelled private example preview.
CREATE TABLE matching_examples (
  id text PRIMARY KEY CHECK (id LIKE 'example-%'),
  kind text NOT NULL CHECK (kind IN ('problem', 'capability')),
  domain text NOT NULL CHECK (domain IN ('ai', 'global')),
  draft jsonb NOT NULL CHECK (jsonb_typeof(draft) = 'object'),
  seed_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX matching_examples_kind_idx ON matching_examples (kind, id);
REVOKE ALL ON TABLE matching_examples FROM PUBLIC;
