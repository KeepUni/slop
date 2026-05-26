import { route } from "./decorators.js";

export class UsersController {
  @route("/users/:id")
  handler(id: string): string {
    return `user ${id}`;
  }
}
