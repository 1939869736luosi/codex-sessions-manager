create table threads (
  id text primary key,
  title text not null,
  first_user_message text not null,
  created_at integer not null,
  updated_at integer not null,
  created_at_ms integer,
  updated_at_ms integer,
  recency_at integer,
  recency_at_ms integer,
  history_mode text check (history_mode in ('legacy', 'paginated')),
  archived integer not null default 0,
  rollout_path text,
  model text,
  model_provider text,
  cwd text
);
