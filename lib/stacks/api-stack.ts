import * as cdk from 'aws-cdk-lib';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayv2integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import * as path from 'path';
import { MamaTables } from './database-stack';

export interface MamaSecrets {
  whatsapp: secretsmanager.ISecret;
  n8n: secretsmanager.ISecret;
}

export interface ApiStackProps extends cdk.StackProps {
  tables: MamaTables;
  secrets: MamaSecrets;
}

export class ApiStack extends cdk.Stack {
  public readonly webhookUrl: string;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const { tables, secrets } = props;
    const familiesTable = tables.families.tableName;

    // ── Alerting SNS Topic ─────────────────────────────────────────────────
    const alertTopic = new sns.Topic(this, 'AlertTopic', {
      topicName: 'mama-alerts',
    });

    const adminEmail = this.node.tryGetContext('adminEmail') as string | undefined;
    if (adminEmail) {
      alertTopic.addSubscription(new snsSubscriptions.EmailSubscription(adminEmail));
    }

    // ── SQS: Main message queue (FIFO for ordering per sender) + DLQ ───────
    const messageDlq = new sqs.Queue(this, 'MessageDlq', {
      queueName: 'mama-message-dlq.fifo',
      fifo: true,
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    const messageQueue = new sqs.Queue(this, 'MessageQueue', {
      queueName: 'mama-message-queue.fifo',
      fifo: true,
      contentBasedDeduplication: true,
      visibilityTimeout: cdk.Duration.seconds(60), // must be >= Lambda timeout
      deadLetterQueue: {
        queue: messageDlq,
        maxReceiveCount: 3,
      },
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    // Alarm: DLQ depth > 0 means a message failed 3 times → alert
    const dlqAlarm = new cloudwatch.Alarm(this, 'DlqDepthAlarm', {
      alarmName: 'mama-dlq-depth',
      alarmDescription: 'Messages landed in the DLQ — requires investigation',
      metric: messageDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(1),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    dlqAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alertTopic));

    // ── WebhookReceiver Lambda ─────────────────────────────────────────────
    const webhookReceiver = new lambdaNodejs.NodejsFunction(this, 'WebhookReceiver', {
      functionName: 'mama-webhook-receiver',
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, '../../../lambdas/webhook-receiver/index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      environment: {
        MESSAGE_QUEUE_URL: messageQueue.queueUrl,
        WHATSAPP_SECRETS_ARN: secrets.whatsapp.secretArn,
        FAMILIES_TABLE: familiesTable,
        WEBHOOK_VERIFY_TOKEN: (this.node.tryGetContext('webhookVerifyToken') as string | undefined) ?? 'mama-reunion-2025-secret',
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: ['@aws-sdk/*'],
      },
    });

    messageQueue.grantSendMessages(webhookReceiver);
    secrets.whatsapp.grantRead(webhookReceiver);
    tables.families.grantReadData(webhookReceiver);

    // Alarm: WebhookReceiver errors
    const webhookErrorAlarm = new cloudwatch.Alarm(this, 'WebhookReceiverErrorAlarm', {
      alarmName: 'mama-webhook-receiver-errors',
      metric: webhookReceiver.metricErrors({ period: cdk.Duration.minutes(5) }),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    });
    webhookErrorAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alertTopic));

    // ── MessageProcessor Lambda ────────────────────────────────────────────
    const messageProcessor = new lambdaNodejs.NodejsFunction(this, 'MessageProcessor', {
      functionName: 'mama-message-processor',
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, '../../../lambdas/message-processor/index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        FAMILIES_TABLE: familiesTable,
        FAMILY_MEMBERS_TABLE: tables.familyMembers.tableName,
        REUNION_INFO_TABLE: tables.reunionInfo.tableName,
        TASKS_TABLE: tables.tasks.tableName,
        CONVERSATION_HISTORY_TABLE: tables.conversationHistory.tableName,
        WHATSAPP_SECRETS_ARN: secrets.whatsapp.secretArn,
        N8N_SECRETS_ARN: secrets.n8n.secretArn,
        BOT_PHONE_NUMBER: this.node.tryGetContext('botPhoneNumber') as string ?? '',
        QA_HANDLER_FUNCTION: 'mama-qa-handler',
        REGISTRATION_HANDLER_FUNCTION: 'mama-registration-handler',
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: ['@aws-sdk/*'],
      },
    });

    // Grant MessageProcessor access to all tables
    tables.families.grantReadData(messageProcessor);
    tables.familyMembers.grantReadWriteData(messageProcessor);
    tables.reunionInfo.grantReadWriteData(messageProcessor);
    tables.tasks.grantReadWriteData(messageProcessor);
    tables.conversationHistory.grantReadWriteData(messageProcessor);
    secrets.whatsapp.grantRead(messageProcessor);
    secrets.n8n.grantRead(messageProcessor);

    // Connect SQS → MessageProcessor
    messageProcessor.addEventSource(new lambdaEventSources.SqsEventSource(messageQueue, {
      batchSize: 1,
      reportBatchItemFailures: true,
    }));

    // Allow MessageProcessor to invoke downstream Lambdas
    messageProcessor.addToRolePolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [
        `arn:aws:lambda:${this.region}:${this.account}:function:mama-qa-handler`,
        `arn:aws:lambda:${this.region}:${this.account}:function:mama-family-tree-handler`,
        `arn:aws:lambda:${this.region}:${this.account}:function:mama-email-handler`,
        `arn:aws:lambda:${this.region}:${this.account}:function:mama-registration-handler`,
        `arn:aws:lambda:${this.region}:${this.account}:function:mama-memory-handler`,
        `arn:aws:lambda:${this.region}:${this.account}:function:mama-carpool-handler`,
        `arn:aws:lambda:${this.region}:${this.account}:function:mama-trivia-handler`,
      ],
    }));

    // ── RegistrationHandler Lambda ─────────────────────────────────────────
    const registrationHandler = new lambdaNodejs.NodejsFunction(this, 'RegistrationHandler', {
      functionName: 'mama-registration-handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, '../../../lambdas/registration-handler/index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        FAMILIES_TABLE: familiesTable,
        FAMILY_MEMBERS_TABLE: tables.familyMembers.tableName,
        REUNION_INFO_TABLE: tables.reunionInfo.tableName,
        CONVERSATION_HISTORY_TABLE: tables.conversationHistory.tableName,
        WHATSAPP_SECRETS_ARN: secrets.whatsapp.secretArn,
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: ['@aws-sdk/*'],
      },
    });

    tables.families.grantReadData(registrationHandler);
    tables.familyMembers.grantReadWriteData(registrationHandler);
    tables.reunionInfo.grantReadData(registrationHandler);
    tables.conversationHistory.grantReadWriteData(registrationHandler);
    secrets.whatsapp.grantRead(registrationHandler);

    // ── QA Handler Lambda ──────────────────────────────────────────────────
    const qaHandler = new lambdaNodejs.NodejsFunction(this, 'QaHandler', {
      functionName: 'mama-qa-handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, '../../../lambdas/qa-handler/index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        FAMILIES_TABLE: familiesTable,
        REUNION_INFO_TABLE: tables.reunionInfo.tableName,
        CONVERSATION_HISTORY_TABLE: tables.conversationHistory.tableName,
        FAMILY_MEMBERS_TABLE: tables.familyMembers.tableName,
        TASKS_TABLE: tables.tasks.tableName,
        WHATSAPP_SECRETS_ARN: secrets.whatsapp.secretArn,
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: ['@aws-sdk/*'],
      },
    });

    tables.families.grantReadData(qaHandler);
    tables.reunionInfo.grantReadData(qaHandler);
    tables.conversationHistory.grantReadWriteData(qaHandler);
    tables.familyMembers.grantReadData(qaHandler);
    tables.tasks.grantReadData(qaHandler);
    secrets.whatsapp.grantRead(qaHandler);

    // ── FamilyTreeHandler Lambda ───────────────────────────────────────────
    const familyTreeHandler = new lambdaNodejs.NodejsFunction(this, 'FamilyTreeHandler', {
      functionName: 'mama-family-tree-handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, '../../../lambdas/family-tree-handler/index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      environment: {
        FAMILIES_TABLE: familiesTable,
        FAMILY_MEMBERS_TABLE: tables.familyMembers.tableName,
        WHATSAPP_SECRETS_ARN: secrets.whatsapp.secretArn,
        TREE_URL: (this.node.tryGetContext('treeUrl') as string | undefined) ?? '',
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: ['@aws-sdk/*'],
      },
    });

    tables.families.grantReadData(familyTreeHandler);
    tables.familyMembers.grantReadWriteData(familyTreeHandler);
    secrets.whatsapp.grantRead(familyTreeHandler);

    // ── AdminHandler Lambda ────────────────────────────────────────────────
    const adminHandler = new lambdaNodejs.NodejsFunction(this, 'AdminHandler', {
      functionName: 'mama-admin-handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, '../../../lambdas/admin-handler/index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        FAMILIES_TABLE: familiesTable,
        FAMILY_MEMBERS_TABLE: tables.familyMembers.tableName,
        REUNION_INFO_TABLE: tables.reunionInfo.tableName,
        TASKS_TABLE: tables.tasks.tableName,
        AUTH_USERS_TABLE: tables.authUsers.tableName,
        WHATSAPP_SECRETS_ARN: secrets.whatsapp.secretArn,
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: ['@aws-sdk/*'],
      },
    });

    tables.families.grantReadWriteData(adminHandler);  // admin can create/update families
    tables.familyMembers.grantReadWriteData(adminHandler);
    tables.reunionInfo.grantReadWriteData(adminHandler);
    tables.tasks.grantReadWriteData(adminHandler);
    tables.authUsers.grantReadWriteData(adminHandler);
    secrets.whatsapp.grantRead(adminHandler);

    // ── EmailHandler Lambda ────────────────────────────────────────────────
    const emailHandler = new lambdaNodejs.NodejsFunction(this, 'EmailHandler', {
      functionName: 'mama-email-handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, '../../../lambdas/email-handler/index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        FAMILIES_TABLE: familiesTable,
        FAMILY_MEMBERS_TABLE: tables.familyMembers.tableName,
        TASKS_TABLE: tables.tasks.tableName,
        REUNION_INFO_TABLE: tables.reunionInfo.tableName,
        WHATSAPP_SECRETS_ARN: secrets.whatsapp.secretArn,
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: ['@aws-sdk/*'],
      },
    });

    tables.families.grantReadData(emailHandler);
    tables.familyMembers.grantReadData(emailHandler);
    tables.tasks.grantReadData(emailHandler);
    tables.reunionInfo.grantReadData(emailHandler);
    secrets.whatsapp.grantRead(emailHandler);

    // ── MemoryHandler Lambda ───────────────────────────────────────────────────
    const memoryHandler = new lambdaNodejs.NodejsFunction(this, 'MemoryHandler', {
      functionName: 'mama-memory-handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, '../../../lambdas/memory-handler/index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        FAMILIES_TABLE: familiesTable,
        MEMORIES_TABLE: tables.memories.tableName,
        FAMILY_MEMBERS_TABLE: tables.familyMembers.tableName,
        WHATSAPP_SECRETS_ARN: secrets.whatsapp.secretArn,
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
      bundling: { minify: true, sourceMap: true, externalModules: ['@aws-sdk/*'] },
    });

    tables.families.grantReadData(memoryHandler);
    tables.memories.grantReadWriteData(memoryHandler);
    tables.familyMembers.grantReadData(memoryHandler);
    secrets.whatsapp.grantRead(memoryHandler);

    // ── CarpoolHandler Lambda ──────────────────────────────────────────────────
    const carpoolHandler = new lambdaNodejs.NodejsFunction(this, 'CarpoolHandler', {
      functionName: 'mama-carpool-handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, '../../../lambdas/carpool-handler/index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        FAMILIES_TABLE: familiesTable,
        CARPOOLS_TABLE: tables.carpools.tableName,
        FAMILY_MEMBERS_TABLE: tables.familyMembers.tableName,
        WHATSAPP_SECRETS_ARN: secrets.whatsapp.secretArn,
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
      bundling: { minify: true, sourceMap: true, externalModules: ['@aws-sdk/*'] },
    });

    tables.families.grantReadData(carpoolHandler);
    tables.carpools.grantReadWriteData(carpoolHandler);
    tables.familyMembers.grantReadData(carpoolHandler);
    secrets.whatsapp.grantRead(carpoolHandler);

    // ── TriviaHandler Lambda ───────────────────────────────────────────────────
    const triviaHandler = new lambdaNodejs.NodejsFunction(this, 'TriviaHandler', {
      functionName: 'mama-trivia-handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, '../../../lambdas/trivia-handler/index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      environment: {
        FAMILIES_TABLE: familiesTable,
        TRIVIA_TABLE: tables.trivia.tableName,
        FAMILY_MEMBERS_TABLE: tables.familyMembers.tableName,
        REUNION_INFO_TABLE: tables.reunionInfo.tableName,
        WHATSAPP_SECRETS_ARN: secrets.whatsapp.secretArn,
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
      bundling: { minify: true, sourceMap: true, externalModules: ['@aws-sdk/*'] },
    });

    tables.families.grantReadData(triviaHandler);
    tables.trivia.grantReadWriteData(triviaHandler);
    tables.familyMembers.grantReadData(triviaHandler);
    tables.reunionInfo.grantReadData(triviaHandler);
    secrets.whatsapp.grantRead(triviaHandler);

    // No SES needed — email is sent via n8n Gmail workflow

    // ── API Gateway HTTP API ───────────────────────────────────────────────
    const api = new apigatewayv2.HttpApi(this, 'MamaApi', {
      apiName: 'mama-reunion-api',
      description: 'Family Reunion Bot — WhatsApp webhook + admin API',
      corsPreflight: {
        allowHeaders: ['Content-Type', 'Authorization', 'X-Hub-Signature-256'],
        allowMethods: [
          apigatewayv2.CorsHttpMethod.GET,
          apigatewayv2.CorsHttpMethod.POST,
          apigatewayv2.CorsHttpMethod.PUT,
          apigatewayv2.CorsHttpMethod.DELETE,
          apigatewayv2.CorsHttpMethod.OPTIONS,
        ],
        allowOrigins: ['*'],
      },
      defaultAuthorizer: undefined,
    });

    // Webhook routes — no auth (Meta sends its own signature)
    const webhookIntegration = new apigatewayv2integrations.HttpLambdaIntegration(
      'WebhookIntegration',
      webhookReceiver,
    );
    api.addRoutes({
      path: '/webhook',
      methods: [apigatewayv2.HttpMethod.GET, apigatewayv2.HttpMethod.POST],
      integration: webhookIntegration,
    });

    // Admin routes — protected by API key header (simple auth for internal tool)
    const adminIntegration = new apigatewayv2integrations.HttpLambdaIntegration(
      'AdminIntegration',
      adminHandler,
    );
    api.addRoutes({
      path: '/admin/{proxy+}',
      methods: [
        apigatewayv2.HttpMethod.GET,
        apigatewayv2.HttpMethod.POST,
        apigatewayv2.HttpMethod.PUT,
        apigatewayv2.HttpMethod.DELETE,
      ],
      integration: adminIntegration,
    });

    this.webhookUrl = api.apiEndpoint;

    // ── Outputs ───────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'WebhookUrl', {
      value: `${api.apiEndpoint}/webhook`,
      description: 'Register this URL as the Meta WhatsApp webhook',
      exportName: 'mama-webhook-url',
    });

    new cdk.CfnOutput(this, 'MessageQueueUrl', {
      value: messageQueue.queueUrl,
      exportName: 'mama-message-queue-url',
    });
  }
}
