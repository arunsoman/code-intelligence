import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { ConfigService } from '../config/config.service';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    return request.headers.authorization === this.config.get('AUTH_TOKEN');
  }
}
