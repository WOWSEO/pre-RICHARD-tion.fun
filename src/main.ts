// This file is intentionally kept as an empty module.
//
// The current prerichardtion.fun app boots from src/main.tsx.
// This old src/main.ts file came from the earlier one-page shell build and was
// still being picked up by TypeScript during `npm run typecheck`, causing stale
// strict-null errors. Keeping this file empty is safer than leaving the old shell
// renderer in place.
export {};
