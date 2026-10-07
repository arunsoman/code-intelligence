import { Module, Global } from '@nestjs/common';
import { ConfigService } from './config.service';

@Global()
@Module({
  providers: [
    { provide: 'CONFIG', useValue: { DATABASE_URL: 'postgres://localhost/nestjs', AUTH_TOKEN: 'secret' } },
    ConfigService,
  ],
  exports: ['CONFIG', ConfigService],
})
export class ConfigModule {}
