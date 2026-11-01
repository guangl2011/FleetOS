/** Tiny shared presentational atoms — pure props, no data fetching. */
import type { ReactNode } from "react";

import type { Tone } from "../format";

const TONE_CLASS: Record<Tone, string> = {
  green: "badge badge-green",
  amber: "badge badge-amber",
  red: "badge badge-red",
  blue: "badge badge-blue",
  gray: "badge badge-gray",
  violet: "badge badge-violet",
};

export function Badge(props: { tone: Tone; children: ReactNode }) {
  return <span className={TONE_CLASS[props.tone]}>{props.children}</span>;
}

export function Panel(props: { title: string; subtitle?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel">
      <header className="panel-header">
        <div>
          <h2>{props.title}</h2>
          {props.subtitle === undefined ? null : <p className="panel-subtitle">{props.subtitle}</p>}
        </div>
        {props.actions === undefined ? null : <div className="panel-actions">{props.actions}</div>}
      </header>
      {props.children}
    </section>
  );
}

export function EmptyState(props: { message: string }) {
  return <p className="empty-state">{props.message}</p>;
}

export function ErrorNote(props: { message: string }) {
  return (
    <p className="error-note" role="alert">
      {props.message}
    </p>
  );
}
