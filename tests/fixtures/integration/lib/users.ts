export interface User {
  id: string;
  name: string;
  email: string;
}

async function fetchUser(id: string): Promise<User> {
  return { id, name: "Ada", email: "ada@example.com" };
}

export async function getUser(id: string): Promise<User> {
  return fetchUser(id);
}

export function buildUserKey(prefix: string, id: string): string {
  return `${prefix}:user:${id}`;
}
