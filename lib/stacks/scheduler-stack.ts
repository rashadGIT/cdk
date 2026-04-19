import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import * as path from 'path';
import { MamaTables } from './database-stack';
import { MamaSecrets } from './api-stack';

/**
 * Per-family reunion schedule config.
 * Each family needs its own timeline EventBridge rules because they may have
 * different reunion dates. Add an entry here for each family.
 *
 * NOTE: Adding a new family requires a CDK redeploy to create its timeline rules.
 */
export interface FamilyScheduleConfig {
  familyId: string;
  /** ISO date string of reunion day, e.g. "2027-07-03" */
  reunionDate: string;
  /** IANA timezone, e.g. "America/New_York". Used to compute UTC offset. */
  timezoneOffsetHours: number; // UTC offset in hours (e.g. -4 for EDT, -5 for EST)
}

export interface SchedulerStackProps extends cdk.StackProps {
  tables: MamaTables;
  secrets: MamaSecrets;
  /**
   * Families to create timeline EventBridge rules for.
   * If not provided, defaults to Barnett family (July 3, 2027, -4 UTC).
   */
  families?: FamilyScheduleConfig[];
}

export class SchedulerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: SchedulerStackProps) {
    super(scope, id, props);

    const { tables, secrets } = props;

    const families: FamilyScheduleConfig[] = props.families ?? [
      { familyId: 'barnett', reunionDate: '2027-07-03', timezoneOffsetHours: -4 },
    ];

    // ── BirthdayChecker Lambda ─────────────────────────────────────────────
    // Runs daily at 8 AM ET; loops over all active families internally
    const birthdayChecker = new lambdaNodejs.NodejsFunction(this, 'BirthdayChecker', {
      functionName: 'mama-birthday-checker',
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, '../../../lambdas/birthday-checker/index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      environment: {
        FAMILIES_TABLE: tables.families.tableName,
        FAMILY_MEMBERS_TABLE: tables.familyMembers.tableName,
        REUNION_INFO_TABLE: tables.reunionInfo.tableName,
        WHATSAPP_SECRETS_ARN: secrets.whatsapp.secretArn,
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
      bundling: { minify: true, sourceMap: true, externalModules: ['@aws-sdk/*'] },
    });

    tables.families.grantReadData(birthdayChecker);
    tables.familyMembers.grantReadData(birthdayChecker);
    tables.reunionInfo.grantReadData(birthdayChecker);
    secrets.whatsapp.grantRead(birthdayChecker);

    new events.Rule(this, 'BirthdayDailyRule', {
      ruleName: 'mama-birthday-daily-check',
      description: 'Triggers birthday checker every morning (loops all families)',
      schedule: events.Schedule.cron({ hour: '13', minute: '0' }), // 8 AM ET = 13:00 UTC
      targets: [new eventsTargets.LambdaFunction(birthdayChecker)],
    });

    // ── CountdownAlert Lambda ──────────────────────────────────────────────
    // Runs every Monday at 9 AM ET; loops over all active families internally
    const countdownAlert = new lambdaNodejs.NodejsFunction(this, 'CountdownAlert', {
      functionName: 'mama-countdown-alert',
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, '../../../lambdas/countdown-alert/index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      environment: {
        FAMILIES_TABLE: tables.families.tableName,
        REUNION_INFO_TABLE: tables.reunionInfo.tableName,
        FAMILY_MEMBERS_TABLE: tables.familyMembers.tableName,
        TASKS_TABLE: tables.tasks.tableName,
        WHATSAPP_SECRETS_ARN: secrets.whatsapp.secretArn,
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
      bundling: { minify: true, sourceMap: true, externalModules: ['@aws-sdk/*'] },
    });

    tables.families.grantReadData(countdownAlert);
    tables.reunionInfo.grantReadData(countdownAlert);
    tables.familyMembers.grantReadData(countdownAlert);
    tables.tasks.grantReadData(countdownAlert);
    secrets.whatsapp.grantRead(countdownAlert);

    new events.Rule(this, 'CountdownWeeklyRule', {
      ruleName: 'mama-countdown-weekly',
      description: 'Sends weekly reunion countdown every Monday (loops all families)',
      schedule: events.Schedule.cron({ weekDay: 'MON', hour: '14', minute: '0' }), // 9 AM ET = 14:00 UTC
      targets: [new eventsTargets.LambdaFunction(countdownAlert)],
    });

    // ── TaskDeadlineChecker Lambda ─────────────────────────────────────────
    // Runs daily at 9 AM ET; loops over all active families internally
    const taskDeadlineChecker = new lambdaNodejs.NodejsFunction(this, 'TaskDeadlineChecker', {
      functionName: 'mama-task-deadline-checker',
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, '../../../lambdas/task-deadline-checker/index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      environment: {
        FAMILIES_TABLE: tables.families.tableName,
        TASKS_TABLE: tables.tasks.tableName,
        FAMILY_MEMBERS_TABLE: tables.familyMembers.tableName,
        REUNION_INFO_TABLE: tables.reunionInfo.tableName,
        WHATSAPP_SECRETS_ARN: secrets.whatsapp.secretArn,
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
      bundling: { minify: true, sourceMap: true, externalModules: ['@aws-sdk/*'] },
    });

    tables.families.grantReadData(taskDeadlineChecker);
    tables.tasks.grantReadWriteData(taskDeadlineChecker);
    tables.familyMembers.grantReadData(taskDeadlineChecker);
    tables.reunionInfo.grantReadData(taskDeadlineChecker);
    secrets.whatsapp.grantRead(taskDeadlineChecker);

    new events.Rule(this, 'TaskDeadlineDailyRule', {
      ruleName: 'mama-task-deadline-daily',
      description: 'Checks task deadlines daily and DMs assignees (loops all families)',
      schedule: events.Schedule.cron({ hour: '14', minute: '0' }), // 9 AM ET = 14:00 UTC
      targets: [new eventsTargets.LambdaFunction(taskDeadlineChecker)],
    });

    // ── ReunionTimeline Lambda ─────────────────────────────────────────────
    // One Lambda, multiple per-family EventBridge rules (different reunion dates)
    const reunionTimeline = new lambdaNodejs.NodejsFunction(this, 'ReunionTimeline', {
      functionName: 'mama-reunion-timeline',
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, '../../../lambdas/reunion-timeline/index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(120),
      memorySize: 256,
      environment: {
        FAMILIES_TABLE: tables.families.tableName,
        REUNION_INFO_TABLE: tables.reunionInfo.tableName,
        FAMILY_MEMBERS_TABLE: tables.familyMembers.tableName,
        WHATSAPP_SECRETS_ARN: secrets.whatsapp.secretArn,
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
      bundling: { minify: true, sourceMap: true, externalModules: ['@aws-sdk/*'] },
    });

    tables.families.grantReadData(reunionTimeline);
    tables.reunionInfo.grantReadData(reunionTimeline);
    tables.familyMembers.grantReadData(reunionTimeline);
    secrets.whatsapp.grantRead(reunionTimeline);

    // Per-family timeline slot offsets (hours before/after reunion day midnight UTC)
    // Slot times relative to reunion day; offsets applied per family timezone
    interface SlotDef { id: string; slot: string; dayOffset: number; hour24Local: number }
    const TIMELINE_SLOTS: SlotDef[] = [
      { id: 'Morning',  slot: 'morning',  dayOffset: 0, hour24Local: 8  }, // 8 AM reunion day
      { id: 'HourOut',  slot: 'hour_out', dayOffset: 0, hour24Local: 11 }, // 11 AM reunion day
      { id: 'Start',    slot: 'start',    dayOffset: 0, hour24Local: 12 }, // noon reunion day
      { id: 'Dinner',   slot: 'dinner',   dayOffset: 0, hour24Local: 19 }, // 7 PM reunion day
      { id: 'Evening',  slot: 'evening',  dayOffset: 0, hour24Local: 22 }, // 10 PM reunion day
      { id: 'After',    slot: 'after',    dayOffset: 1, hour24Local: 11 }, // 11 AM day after
    ];

    // Create one EventBridge rule per family per slot
    for (const familyCfg of families) {
      const [year, month, day] = familyCfg.reunionDate.split('-').map(Number);

      for (const slotDef of TIMELINE_SLOTS) {
        // Compute UTC hour: local hour - offset (e.g. 8 AM EDT = 8 - (-4) = 12 UTC)
        const utcHour = slotDef.hour24Local - familyCfg.timezoneOffsetHours;
        const utcDay = day + slotDef.dayOffset + (utcHour >= 24 ? 1 : 0);
        const normalizedHour = ((utcHour % 24) + 24) % 24;
        const monthNames = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
        const monthStr = monthNames[month - 1];

        new events.Rule(this, `Timeline${familyCfg.familyId.charAt(0).toUpperCase() + familyCfg.familyId.slice(1)}${slotDef.id}Rule`, {
          ruleName: `mama-timeline-${familyCfg.familyId}-${slotDef.slot}`,
          description: `Sends "${slotDef.slot}" message for ${familyCfg.familyId} family`,
          schedule: events.Schedule.cron({
            year: String(year),
            month: monthStr,
            day: String(utcDay),
            hour: String(normalizedHour),
            minute: '0',
          }),
          targets: [new eventsTargets.LambdaFunction(reunionTimeline, {
            event: events.RuleTargetInput.fromObject({ slot: slotDef.slot, familyId: familyCfg.familyId }),
          })],
        });
      }
    }

    // ── DailyFact Lambda ───────────────────────────────────────────────────
    // Sends a "Did you know?" family fact every morning at 9 AM ET; loops all families
    const dailyFact = new lambdaNodejs.NodejsFunction(this, 'DailyFact', {
      functionName: 'mama-daily-fact',
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, '../../../lambdas/daily-fact/index.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(120),
      memorySize: 256,
      environment: {
        FAMILIES_TABLE: tables.families.tableName,
        FAMILY_MEMBERS_TABLE: tables.familyMembers.tableName,
        WHATSAPP_SECRETS_ARN: secrets.whatsapp.secretArn,
      },
      logRetention: logs.RetentionDays.ONE_MONTH,
      bundling: { minify: true, sourceMap: true, externalModules: ['@aws-sdk/*'] },
    });

    tables.families.grantReadData(dailyFact);
    tables.familyMembers.grantReadData(dailyFact);
    secrets.whatsapp.grantRead(dailyFact);

    new events.Rule(this, 'DailyFactRule', {
      ruleName: 'mama-daily-fact',
      description: 'Sends a daily family fact every morning (loops all families)',
      schedule: events.Schedule.cron({ hour: '14', minute: '0' }), // 9 AM ET = 14:00 UTC
      targets: [new eventsTargets.LambdaFunction(dailyFact)],
    });

    // ── TriviaWeekly EventBridge rule ──────────────────────────────────────
    // TriviaHandler Lambda is defined in api-stack (also handles user answers).
    // Referenced by ARN here for the EventBridge weekly trigger.
    const triviaHandlerArn = `arn:aws:lambda:${this.region}:${this.account}:function:mama-trivia-handler`;
    const triviaHandlerFn = lambda.Function.fromFunctionArn(this, 'TriviaHandlerRef', triviaHandlerArn);

    new events.Rule(this, 'TriviaWeeklyRule', {
      ruleName: 'mama-trivia-weekly',
      description: 'Sends weekly family trivia question every Monday at 10 AM ET (loops all families)',
      schedule: events.Schedule.cron({ weekDay: 'MON', hour: '15', minute: '0' }), // 10 AM ET = 15:00 UTC
      targets: [new eventsTargets.LambdaFunction(triviaHandlerFn as lambda.Function, {
        event: events.RuleTargetInput.fromObject({ source: 'aws.events' }),
      })],
    });
  }
}
