import * as cdk from 'aws-cdk-lib';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { MamaSecrets } from './api-stack';

/**
 * SecretsStack
 *
 * Creates Secrets Manager placeholders. After deploying this stack,
 * populate the secrets via the AWS Console or:
 *
 *   aws secretsmanager put-secret-value \
 *     --secret-id /mama/meta/whatsapp \
 *     --secret-string '{"accessToken":"...","phoneNumberId":"...","wabaId":"...","appSecret":"...","verifyToken":"..."}'
 *
 *   aws secretsmanager put-secret-value \
 *     --secret-id /mama/n8n/webhook \
 *     --secret-string '{"webhookUrl":"https://your-n8n-instance.com/webhook","authToken":"..."}'
 */
export class SecretsStack extends cdk.Stack {
  public readonly secrets: MamaSecrets;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const whatsapp = new secretsmanager.Secret(this, 'WhatsAppSecret', {
      secretName: '/mama/meta/whatsapp',
      description: 'Meta WhatsApp Business API credentials',
      secretObjectValue: {
        accessToken: cdk.SecretValue.unsafePlainText('PLACEHOLDER'),
        phoneNumberId: cdk.SecretValue.unsafePlainText('PLACEHOLDER'),
        wabaId: cdk.SecretValue.unsafePlainText('PLACEHOLDER'),
        appSecret: cdk.SecretValue.unsafePlainText('PLACEHOLDER'),
        verifyToken: cdk.SecretValue.unsafePlainText('PLACEHOLDER'),
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const n8n = new secretsmanager.Secret(this, 'N8nSecret', {
      secretName: '/mama/n8n/webhook',
      description: 'n8n webhook URL and shared auth token',
      secretObjectValue: {
        webhookUrl: cdk.SecretValue.unsafePlainText('PLACEHOLDER'),
        authToken: cdk.SecretValue.unsafePlainText('PLACEHOLDER'),
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    new cdk.CfnOutput(this, 'WhatsAppSecretArn', {
      value: whatsapp.secretArn,
      exportName: 'mama-whatsapp-secret-arn',
    });

    new cdk.CfnOutput(this, 'N8nSecretArn', {
      value: n8n.secretArn,
      exportName: 'mama-n8n-secret-arn',
    });

    this.secrets = { whatsapp, n8n };
  }
}
