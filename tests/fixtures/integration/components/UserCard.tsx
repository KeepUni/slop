import type { User } from "../lib/users.js";

export function UserCard({ user }: { user: User }) {
  return (
    <div className="rounded border p-4">
      <h2>{user.name}</h2>
      <span>{user.email}</span>
    </div>
  );
}
