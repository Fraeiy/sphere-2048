-- Enable Supabase Realtime for leaderboard live updates
ALTER PUBLICATION supabase_realtime ADD TABLE leaderboard_entries;