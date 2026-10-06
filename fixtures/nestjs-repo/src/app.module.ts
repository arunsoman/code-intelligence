import { Module } from '@nestjs/common';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { ConfigModule } from './config/config.module';

@Module({
  imports: [UsersModule, AuthModule, ConfigModule],
  controllers: [],
  providers: [],
})
export class AppModule {}
