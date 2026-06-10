"use client";

import { useState } from "react";

import type { DeployStore } from "../_lib/store";

// Crew selection / creation. A crew is the unit a claim locks to; the active
// crew is what claim/deploy attribute to. Membership is server-side (join), but
// "which of my crews am I acting as right now" is a local choice (localStorage).
export function CrewBar({ store }: { store: DeployStore }) {
  const [name, setName] = useState("");
  const [joinId, setJoinId] = useState("");

  const myCrews = store.crews.filter((c) => store.myCrewIds.includes(c.id));
  const otherCrews = store.crews.filter((c) => !store.myCrewIds.includes(c.id));

  return (
    <section className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-950 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs uppercase tracking-wide text-zinc-500">
          Acting as
        </span>
        {myCrews.length === 0 ? (
          <span className="text-sm text-zinc-500">no crew yet</span>
        ) : (
          myCrews.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => store.setActiveCrew(c.id)}
              className={`rounded-full px-3 py-1 text-sm ${
                store.activeCrewId === c.id
                  ? "bg-brand text-white"
                  : "border border-zinc-700 text-zinc-300 hover:bg-zinc-800"
              }`}
            >
              {c.name}
              <span className="ml-1 text-xs opacity-70">
                ({c.memberUserIds.length})
              </span>
            </button>
          ))
        )}
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <form
          className="flex flex-1 gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const n = name.trim();
            if (n) {
              void store.createCrew(n);
              setName("");
            }
          }}
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="New crew name"
            maxLength={80}
            className="flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600"
          />
          <button
            type="submit"
            className="btn-primary rounded px-3 py-1.5 text-sm"
          >
            Start
          </button>
        </form>

        {otherCrews.length > 0 && (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const id = Number.parseInt(joinId, 10);
              if (Number.isInteger(id)) {
                void store.joinCrew(id);
                setJoinId("");
              }
            }}
          >
            <select
              value={joinId}
              onChange={(e) => setJoinId(e.target.value)}
              className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100"
            >
              <option value="">Join a crew…</option>
              {otherCrews.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <button
              type="submit"
              disabled={!joinId}
              className="rounded border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 enabled:hover:bg-zinc-800 disabled:opacity-40"
            >
              Join
            </button>
          </form>
        )}
      </div>
    </section>
  );
}
