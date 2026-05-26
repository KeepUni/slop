import { UserCard } from "../components/UserCard.js";
import { getUser } from "../lib/users.js";
import { formatTimestamp } from "../lib/format.js";

export default async function Page() {
  const user = await getUser("42");
  return (
    <div>
      <UserCard user={user} />
      <p>signed in at {formatTimestamp(new Date())}</p>
    </div>
  );
}
