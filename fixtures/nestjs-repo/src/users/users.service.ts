import { Injectable } from '@nestjs/common';
import { User } from './user.model';

@Injectable()
export class UsersService {
  private users: User[] = [];

  findAll(): User[] {
    return this.users;
  }

  findOne(id: string): User | undefined {
    return this.users.find((u) => u.id === id);
  }

  create(user: User): User {
    this.users.push(user);
    return user;
  }
}
