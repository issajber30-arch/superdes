from psycopg.types.json import Jsonb


def log(conn, action: str, studio_id=None, actor_id=None, target_type=None, target_id=None, data=None):
    conn.execute(
        "insert into audit_events (studio_id, actor_id, action, target_type, target_id, data) values (%s,%s,%s,%s,%s,%s)",
        (studio_id, actor_id, action, target_type, str(target_id) if target_id else None, Jsonb(data or {})))
