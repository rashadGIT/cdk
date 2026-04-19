#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { DatabaseStack } from '../lib/stacks/database-stack';
import { StorageStack } from '../lib/stacks/storage-stack';
import { SecretsStack } from '../lib/stacks/secrets-stack';
import { ApiStack } from '../lib/stacks/api-stack';
import { SchedulerStack } from '../lib/stacks/scheduler-stack';

const app = new cdk.App();

const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};

const dbStack = new DatabaseStack(app, 'MamaDatabase', { env });
const storageStack = new StorageStack(app, 'MamaStorage', { env });
const secretsStack = new SecretsStack(app, 'MamaSecrets', { env });

const apiStack = new ApiStack(app, 'MamaApi', {
  env,
  tables: dbStack.tables,
  secrets: secretsStack.secrets,
});

new SchedulerStack(app, 'MamaScheduler', {
  env,
  tables: dbStack.tables,
  secrets: secretsStack.secrets,
});

// Suppress unused variable warnings
void storageStack;
void apiStack;
