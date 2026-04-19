import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cloudfrontOrigins from 'aws-cdk-lib/aws-cloudfront-origins';
import { Construct } from 'constructs';

export class StorageStack extends cdk.Stack {
  public readonly documentsBucket: s3.Bucket;
  public readonly adminUiBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── Documents bucket — private, for photos, CSV imports, invite PDFs ──
    this.documentsBucket = new s3.Bucket(this, 'DocumentsBucket', {
      bucketName: `mama-reunion-documents-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      lifecycleRules: [
        {
          id: 'delete-old-csv-imports',
          prefix: 'imports/',
          expiration: cdk.Duration.days(30),
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ── Admin UI bucket — serves the React SPA via CloudFront ─────────────
    this.adminUiBucket = new s3.Bucket(this, 'AdminUiBucket', {
      bucketName: `mama-admin-ui-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const originAccessIdentity = new cloudfront.OriginAccessIdentity(this, 'AdminUiOai', {
      comment: 'OAI for Mama Admin UI',
    });
    this.adminUiBucket.grantRead(originAccessIdentity);

    const distribution = new cloudfront.CloudFrontWebDistribution(this, 'AdminUiDistribution', {
      originConfigs: [
        {
          s3OriginSource: {
            s3BucketSource: this.adminUiBucket,
            originAccessIdentity,
          },
          behaviors: [{ isDefaultBehavior: true, compress: true }],
        },
      ],
      errorConfigurations: [
        {
          // SPA routing: return index.html for all 404s
          errorCode: 404,
          responseCode: 200,
          responsePagePath: '/index.html',
        },
      ],
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    });

    new cdk.CfnOutput(this, 'AdminUiUrl', {
      value: `https://${distribution.distributionDomainName}`,
      description: 'Admin UI CloudFront URL',
      exportName: 'mama-admin-ui-url',
    });

    new cdk.CfnOutput(this, 'DocumentsBucketName', {
      value: this.documentsBucket.bucketName,
      exportName: 'mama-documents-bucket',
    });
  }
}
