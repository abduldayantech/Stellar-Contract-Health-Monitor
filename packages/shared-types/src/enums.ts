export const CONTRACT_STATUSES = ['ACTIVE', 'PAUSED', 'ERROR'] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

export const STORAGE_ENTRY_KINDS = ['INSTANCE', 'CODE', 'PERSISTENT', 'TEMPORARY'] as const;
export type StorageEntryKind = (typeof STORAGE_ENTRY_KINDS)[number];

export const ALERT_RULE_TYPES = ['EVENT_MATCH', 'TTL_EXPIRY', 'INACTIVITY'] as const;
export type AlertRuleType = (typeof ALERT_RULE_TYPES)[number];

export const ALERT_SEVERITIES = ['INFO', 'WARNING', 'CRITICAL'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export const ALERT_STATUSES = ['TRIGGERED', 'ACKNOWLEDGED', 'RESOLVED'] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

export const DESTINATION_TYPES = ['WEBHOOK', 'EMAIL', 'SLACK', 'DISCORD'] as const;
export type DestinationType = (typeof DESTINATION_TYPES)[number];

export const DELIVERY_STATUSES = ['PENDING', 'SUCCEEDED', 'FAILED'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const EVENT_TYPES = ['contract', 'system', 'diagnostic'] as const;
export type ContractEventType = (typeof EVENT_TYPES)[number];
