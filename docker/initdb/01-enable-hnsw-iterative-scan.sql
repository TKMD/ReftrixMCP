-- Enable pgvector 0.8 HNSW iterative scan for improved search quality
-- pgvector 0.8 HNSW iterative scan を有効化（検索品質・レイテンシ改善）
--
-- This init script runs once when the PostgreSQL container is first created.
-- このスクリプトはPostgreSQLコンテナ初回作成時に1回実行されます。
--
-- 'relaxed_order' mode: iterative scan with relaxed ordering
-- Reduces P95 latency by ~50% while maintaining 95-99% result quality.
--
-- Requires: pgvector >= 0.8.0, vector in shared_preload_libraries (docker-compose.yml)
-- Reference: https://github.com/pgvector/pgvector#iterative-index-scans

ALTER ROLE reftrix SET hnsw.iterative_scan = 'relaxed_order';
