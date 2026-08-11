export interface RepositoryStatus {
  database: "memory" | "postgres";
  connected: boolean;
  reason: string;
}
