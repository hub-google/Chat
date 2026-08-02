import pg from 'pg';

const client = new pg.Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
});

await client.connect();
try {
  const queries = {
    tableCounts: `SELECT schemaname, relname AS table_name, n_live_tup::bigint AS estimated_rows
                    FROM pg_stat_user_tables WHERE schemaname = 'public' ORDER BY relname`,
    topicCategories: `SELECT id, name, description, display_order, is_active
                        FROM public.topic_categories ORDER BY display_order`,
    topicCardCounts: `SELECT c.name, count(t.id)::int AS cards
                        FROM public.topic_categories c
                        LEFT JOIN public.topic_cards t ON t.category_id = c.id
                       GROUP BY c.id, c.name, c.display_order ORDER BY c.display_order`,
    profileQuality: `SELECT count(*)::int AS total,
                            count(*) FILTER (WHERE nickname IS NOT NULL)::int AS nicknames,
                            count(*) FILTER (WHERE gender IS NOT NULL)::int AS genders,
                            count(*) FILTER (WHERE age IS NOT NULL)::int AS ages,
                            count(*) FILTER (WHERE city IS NOT NULL)::int AS cities,
                            count(*) FILTER (WHERE bio IS NOT NULL)::int AS bios,
                            count(*) FILTER (WHERE last_ip IS NOT NULL)::int AS ips,
                            count(*) FILTER (WHERE last_ip_location_zh IS NOT NULL)::int AS ip_locations
                       FROM public.profiles`,
    pool: `SELECT user_id, intent, gender, target_gender, lat, lng,
                  max_distance_km, distance_mode, status,
                  round(extract(epoch FROM (now() - last_ping_at)))::int AS ping_age_seconds
             FROM public.matching_pool ORDER BY created_at`,
    functions: `SELECT pg_get_functiondef(p.oid) AS definition
                  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public' AND p.proname = 'fn_match_user'`,
  };

  for (const [name, sql] of Object.entries(queries)) {
    const { rows } = await client.query(sql);
    console.log(`\n## ${name}\n${JSON.stringify(rows, null, 2)}`);
  }
} finally {
  await client.end();
}
