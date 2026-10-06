import { Module } from '@nestjs/common';
import { AuthGuard } from './auth.guard';
import { ConfigModule } from '../config/config.module';

@Module({
  imports: [ConfigModule],
  providers: [AuthGuard],
  exports: [AuthGuard],
})
export class AuthModule {}
