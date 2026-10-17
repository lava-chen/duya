export class Goals {
  static readonly migrations = [
    {
      id: 8,
      name: "create_session_goals",
      up: (db) => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS session_goals (
            id         TEXT PRIMARY KEY,
            session_id TEXT,
            UNIQUE(session_id)
          );
        `);
      },
    },
  ];
}
