import { Injectable, Inject } from '@nestjs/common';

@Injectable()
export class ConfigService {
  constructor(@Inject('CONFIG') private config: Record<string, string>) {}

  get(key: string): string | undefined {
    return this.config[key];
  }
}
