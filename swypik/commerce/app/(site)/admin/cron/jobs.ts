export interface CronJob {
  name: string;
  endpoint: string;
  method: "GET" | "POST";
  descriptionKey: string;
  scheduleKey: string;
}

export const CRON_JOBS: CronJob[] = [
  {
    name: "abandoned-cart",
    endpoint: "/api/cron/abandoned-cart",
    method: "POST",
    descriptionKey: "job.abandonedCart",
    scheduleKey: "schedule.every4h",
  },
  {
    name: "process-payouts",
    endpoint: "/api/cron/process-payouts",
    method: "POST",
    descriptionKey: "job.processPayouts",
    scheduleKey: "schedule.every30min",
  },
  {
    name: "suspend-unverified",
    endpoint: "/api/cron/suspend-unverified",
    method: "GET",
    descriptionKey: "job.suspendUnverified",
    scheduleKey: "schedule.daily",
  },
];
