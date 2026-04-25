import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export interface MamaTables {
  families: dynamodb.Table;
  familyMembers: dynamodb.Table;
  reunionInfo: dynamodb.Table;
  tasks: dynamodb.Table;
  conversationHistory: dynamodb.Table;
  memories: dynamodb.Table;
  carpools: dynamodb.Table;
  trivia: dynamodb.Table;
  authUsers: dynamodb.Table;
}

export class DatabaseStack extends cdk.Stack {
  public readonly tables: MamaTables;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ----------------------------------------------------------------
    // mama_families  ← NEW: source of truth for per-family config
    // PK: familyId   SK: "CONFIG"
    // GSI-1: phoneNumberId-index (PK: whatsappPhoneNumberId)  ← message routing
    // GSI-2: adminKey-index      (PK: adminApiKey)            ← admin auth
    // ----------------------------------------------------------------
    const families = new dynamodb.Table(this, 'Families', {
      tableName: 'mama-families',
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      partitionKey: { name: 'familyId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    families.addGlobalSecondaryIndex({
      indexName: 'phoneNumberId-index',
      partitionKey: { name: 'whatsappPhoneNumberId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    families.addGlobalSecondaryIndex({
      indexName: 'adminKey-index',
      partitionKey: { name: 'adminApiKey', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ----------------------------------------------------------------
    // family_members
    // PK: memberId  SK: "PROFILE"
    // GSI-1: birthday-index        (PK: birthday MM-DD)
    // GSI-2: phone-index           (PK: familyId, SK: whatsappNumber) ← updated for multi-tenant
    // GSI-3: side-generation-index (PK: side, SK: generation)
    // GSI-4: familyId-sk-index     (PK: familyId, SK: sk)             ← NEW
    // ----------------------------------------------------------------
    const familyMembers = new dynamodb.Table(this, 'FamilyMembers', {
      tableName: 'mama-family-members',
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      partitionKey: { name: 'memberId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    familyMembers.addGlobalSecondaryIndex({
      indexName: 'birthday-index',
      partitionKey: { name: 'birthday', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'memberId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    familyMembers.addGlobalSecondaryIndex({
      indexName: 'phone-index',
      partitionKey: { name: 'whatsappNumber', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'memberId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    familyMembers.addGlobalSecondaryIndex({
      indexName: 'side-generation-index',
      partitionKey: { name: 'side', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'generation', type: dynamodb.AttributeType.NUMBER },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    familyMembers.addGlobalSecondaryIndex({
      indexName: 'email-index',
      partitionKey: { name: 'email', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // TTL: auto-expire PENDING registration records after 72 hours
    const cfnFamilyMembers = familyMembers.node.defaultChild as dynamodb.CfnTable;
    cfnFamilyMembers.timeToLiveSpecification = { attributeName: 'expiresAt', enabled: true };

    // ----------------------------------------------------------------
    // reunion_info
    // PK: infoId (e.g. "barnett#EVENT#main", "barnett#CONFIG#bot")
    // SK: version (e.g. "v1")
    // GSI-1: category-index         (PK: category, SK: updatedAt)
    // GSI-2: familyId-category-index (PK: familyId, SK: category)  ← NEW
    // ----------------------------------------------------------------
    const reunionInfo = new dynamodb.Table(this, 'ReunionInfo', {
      tableName: 'mama-reunion-info',
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      partitionKey: { name: 'infoId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'version', type: dynamodb.AttributeType.STRING },
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    reunionInfo.addGlobalSecondaryIndex({
      indexName: 'category-index',
      partitionKey: { name: 'category', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'updatedAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    reunionInfo.addGlobalSecondaryIndex({
      indexName: 'familyId-category-index',
      partitionKey: { name: 'familyId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'category', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ----------------------------------------------------------------
    // tasks
    // PK: taskId  SK: "TASK"
    // GSI-1: assignee-status-index  (PK: assignedTo, SK: status)
    // GSI-2: dueDate-status-index   (PK: status, SK: dueDate)
    // GSI-3: category-index         (PK: category, SK: dueDate)
    // GSI-4: familyId-status-index  (PK: familyId, SK: status)  ← NEW
    // ----------------------------------------------------------------
    const tasks = new dynamodb.Table(this, 'Tasks', {
      tableName: 'mama-tasks',
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      partitionKey: { name: 'taskId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    tasks.addGlobalSecondaryIndex({
      indexName: 'assignee-status-index',
      partitionKey: { name: 'assignedTo', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    tasks.addGlobalSecondaryIndex({
      indexName: 'dueDate-status-index',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'dueDate', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    tasks.addGlobalSecondaryIndex({
      indexName: 'category-index',
      partitionKey: { name: 'category', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'dueDate', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    tasks.addGlobalSecondaryIndex({
      indexName: 'familyId-status-index',
      partitionKey: { name: 'familyId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ----------------------------------------------------------------
    // conversation_history
    // PK: threadId ("${familyId}#${phone}" — composite key for multi-tenant)
    // SK: timestamp (ISO 8601 — sortable)
    // TTL: expiresAt (30-day auto-expiry)
    // GSI-1: memberId-timestamp-index (PK: memberId, SK: timestamp)
    // ----------------------------------------------------------------
    const conversationHistory = new dynamodb.Table(this, 'ConversationHistory', {
      tableName: 'mama-conversation-history',
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      partitionKey: { name: 'threadId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'expiresAt',
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    conversationHistory.addGlobalSecondaryIndex({
      indexName: 'memberId-timestamp-index',
      partitionKey: { name: 'memberId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ----------------------------------------------------------------
    // mama_memories
    // PK: memoryId  SK: "MEMORY"
    // GSI-1: type-createdAt-index (PK: type, SK: createdAt)
    // familyId stored as attribute; queries add FilterExpression
    // ----------------------------------------------------------------
    const memories = new dynamodb.Table(this, 'Memories', {
      tableName: 'mama-memories',
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      partitionKey: { name: 'memoryId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    memories.addGlobalSecondaryIndex({
      indexName: 'type-createdAt-index',
      partitionKey: { name: 'type', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ----------------------------------------------------------------
    // mama_carpools
    // PK: carpoolId  SK: "CARPOOL"
    // GSI-1: city-status-index (PK: city, SK: status)
    // familyId stored as attribute; queries add FilterExpression
    // ----------------------------------------------------------------
    const carpools = new dynamodb.Table(this, 'Carpools', {
      tableName: 'mama-carpools',
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      partitionKey: { name: 'carpoolId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    carpools.addGlobalSecondaryIndex({
      indexName: 'city-status-index',
      partitionKey: { name: 'city', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ----------------------------------------------------------------
    // mama_trivia
    // PK: gameId  SK: "CURRENT" / phone (leaderboard)
    // gameId values are scoped per-family: "ACTIVE#${familyId}", "LEADERBOARD#${familyId}"
    // ----------------------------------------------------------------
    const trivia = new dynamodb.Table(this, 'Trivia', {
      tableName: 'mama-trivia',
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      partitionKey: { name: 'gameId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ----------------------------------------------------------------
    // mama_auth_users  ← stores hashed passwords for email/password login
    // PK: email (string)
    // ----------------------------------------------------------------
    const authUsers = new dynamodb.Table(this, 'AuthUsers', {
      tableName: 'mama-auth-users',
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      partitionKey: { name: 'email', type: dynamodb.AttributeType.STRING },
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ----------------------------------------------------------------
    // Outputs
    // ----------------------------------------------------------------
    new cdk.CfnOutput(this, 'FamiliesTableName', {
      value: families.tableName,
      exportName: 'mama-families-table',
    });
    new cdk.CfnOutput(this, 'FamilyMembersTableName', {
      value: familyMembers.tableName,
      exportName: 'mama-family-members-table',
    });
    new cdk.CfnOutput(this, 'ReunionInfoTableName', {
      value: reunionInfo.tableName,
      exportName: 'mama-reunion-info-table',
    });
    new cdk.CfnOutput(this, 'TasksTableName', {
      value: tasks.tableName,
      exportName: 'mama-tasks-table',
    });
    new cdk.CfnOutput(this, 'ConversationHistoryTableName', {
      value: conversationHistory.tableName,
      exportName: 'mama-conversation-history-table',
    });
    new cdk.CfnOutput(this, 'MemoriesTableName', {
      value: memories.tableName,
      exportName: 'mama-memories-table',
    });
    new cdk.CfnOutput(this, 'CarpoolsTableName', {
      value: carpools.tableName,
      exportName: 'mama-carpools-table',
    });
    new cdk.CfnOutput(this, 'TriviaTableName', {
      value: trivia.tableName,
      exportName: 'mama-trivia-table',
    });

    new cdk.CfnOutput(this, 'AuthUsersTableName', {
      value: authUsers.tableName,
      exportName: 'mama-auth-users-table',
    });

    this.tables = { families, familyMembers, reunionInfo, tasks, conversationHistory, memories, carpools, trivia, authUsers };
  }
}
