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
    <section className="panel space-y-3 p-3">
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
              className={
                store.activeCrewId === c.id
                  ? "btn btn-sm btn-primary"
                  : "btn btn-sm"
              }
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
            className="field flex-1"
          />
          <button type="submit" className="btn btn-primary">
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
              className="field"
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
              className="btn disabled:opacity-40"
            >
              Join
            </button>
          </form>
        )}
      </div>
    </section>
  );
}
