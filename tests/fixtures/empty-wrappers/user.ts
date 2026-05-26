function fetchUser(id: string) {
  return { id };
}

export function getUser(id: string) {
  return fetchUser(id);
}

export function getUserWithFallback(id: string = "anon") {
  return fetchUser(id);
}

export function findUser(name: string, id: string) {
  return lookup(id, name);
}

function lookup(_id: string, _name: string) {
  return null;
}

export function getUpperUser(id: string) {
  return fetchUser(id.toUpperCase());
}
