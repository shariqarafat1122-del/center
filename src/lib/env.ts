// lib/env.ts
// Workers env bindings ka global holder — process.env replacement.
// Router har request ke start pe setEnv(env) call karta hai.

export interface WorkerEnv {
  FIREBASE_PROJECT_ID: string;
  FIREBASE_CLIENT_EMAIL: string;
  FIREBASE_PRIVATE_KEY: string;
  NEXT_PUBLIC_APP_URL?: string;
  CRON_SECRET?: string;
}

let _env: WorkerEnv | null = null;

export function setEnv(env: WorkerEnv): void {
  _env = env;
}

export function getEnv(): WorkerEnv {
  if (!_env) throw new Error('ENV_NOT_INITIALIZED: setEnv() not called');
  return _env;
}
