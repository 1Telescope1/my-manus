# TypeScript API

NestJS TypeScript parity implementation of the Python API in `../../api`.

## Setup

```powershell
npm install
npm run prisma:generate
```

Create `.env` from `.env.example` and set local Redis/Postgres/COS values as needed. The TS service accepts Python-style names such as `ENV` and `SQLALCHEMY_DATABASE_URI`, and normalizes the SQLAlchemy asyncpg URL for Prisma at runtime.

## Run

```powershell
npm run start:local
```

Local startup runs the TypeScript source through the Nest CLI, so source changes do not require `npm run build` first. The service uses `/api` as the global prefix, matching the Python FastAPI app. If port `8000` is already in use, startup falls back to `8001`.

## Current Scope

The first implementation mirrors the currently explicit Python behavior. Missing Python-side domain models, especially `Session`, are kept as clear TypeScript boundaries instead of being invented.
