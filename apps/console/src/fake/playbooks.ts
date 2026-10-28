import type { PlaybookDefinitionInput } from '@spine/shared-schema';

/**
 * Fixture playbooks, written the way an author would write them (defaults omitted). The
 * fake server parses them with `PlaybookDefinitionSchema`, so they are guaranteed valid.
 */
export const FIXTURE_PLAYBOOKS: { definition: PlaybookDefinitionInput; enabled: boolean }[] = [
  {
    enabled: true,
    definition: {
      apiVersion: 'spine/v1',
      kind: 'Playbook',
      metadata: {
        id: 'contain-c2-beacon',
        name: 'Contain C2 beacon',
        version: 3,
        description:
          'Enrich and score a command-and-control alert, then block the remote indicator after an analyst approves.',
        tags: ['c2', 'containment'],
      },
      trigger: {
        event: 'alert.scored',
        when: { field: 'alert.category', op: 'eq', value: 'command_and_control' },
      },
      start: 'enrich',
      steps: [
        { id: 'enrich', type: 'enrich', name: 'Enrich indicators', next: 'score' },
        { id: 'score', type: 'score', name: 'Re-score with enrichment', next: 'severity-gate' },
        {
          id: 'severity-gate',
          type: 'branch',
          name: 'High enough to contain?',
          branches: [
            { when: { field: 'score.score', op: 'gte', value: 70 }, next: 'approve-block' },
          ],
          default: 'notify-soc',
        },
        {
          id: 'approve-block',
          type: 'approval',
          name: 'Approve firewall block',
          with: {
            approverRole: 'analyst',
            prompt: 'Block {{alert.network.destinationIp}} on the perimeter firewall for 24 h?',
            expiresInMs: 3_600_000,
            onTimeout: 'reject',
          },
          next: 'block-ip',
          onReject: 'notify-soc',
        },
        {
          id: 'block-ip',
          type: 'block_indicator',
          name: 'Block remote IP',
          with: {
            indicatorTypes: ['ipv4', 'domain'],
            durationMinutes: 1440,
            minVerdict: 'malicious',
          },
          compensate: { type: 'unblock_indicator' },
          retry: { maxAttempts: 3, backoffMs: 2000 },
          next: 'open-ticket',
        },
        {
          id: 'open-ticket',
          type: 'create_ticket',
          name: 'Open incident ticket',
          with: {
            queue: 'SOC-INCIDENTS',
            priority: 'high',
            summaryTemplate: 'C2 beacon on {{alert.host.hostname}}',
          },
          compensate: { type: 'close_ticket' },
          next: 'mark-in-progress',
        },
        {
          id: 'mark-in-progress',
          type: 'set_status',
          name: 'Mark alert in progress',
          with: { status: 'in_progress' },
        },
        {
          id: 'notify-soc',
          type: 'notify',
          name: 'Tell the SOC channel',
          with: {
            channel: '#soc-alerts',
            template: 'C2 alert {{alert.title}} needs a look (score {{score.score}}).',
          },
        },
      ],
    },
  },
  {
    enabled: true,
    definition: {
      apiVersion: 'spine/v1',
      kind: 'Playbook',
      metadata: {
        id: 'phishing-triage',
        name: 'Phishing triage',
        version: 1,
        description:
          'Close benign phishing reports automatically; escalate malicious ones to a ticket.',
        tags: ['phishing'],
      },
      trigger: {
        event: 'alert.scored',
        when: { field: 'alert.category', op: 'eq', value: 'phishing' },
      },
      start: 'enrich',
      steps: [
        { id: 'enrich', type: 'enrich', next: 'verdict' },
        {
          id: 'verdict',
          type: 'branch',
          name: 'Any malicious URL or sender?',
          branches: [
            {
              when: {
                any: [
                  { field: 'score.score', op: 'gte', value: 60 },
                  { field: 'alert.labels.reported_by', op: 'exists' },
                ],
              },
              next: 'ticket',
            },
          ],
          default: 'close-benign',
        },
        {
          id: 'ticket',
          type: 'create_ticket',
          with: { queue: 'SOC-PHISHING', priority: 'medium' },
          next: 'notify',
        },
        {
          id: 'notify',
          type: 'notify',
          with: { channel: '#soc-phishing', template: 'Phishing escalated: {{alert.title}}' },
        },
        { id: 'close-benign', type: 'set_status', with: { status: 'false_positive' } },
      ],
    },
  },
  {
    enabled: false,
    definition: {
      apiVersion: 'spine/v1',
      kind: 'Playbook',
      metadata: {
        id: 'brute-force-response',
        name: 'Brute-force response',
        version: 2,
        description: 'Notify the identity team about password-spraying alerts and open a ticket.',
        tags: ['identity', 'credential-access'],
      },
      start: 'enrich',
      steps: [
        { id: 'enrich', type: 'enrich', next: 'notify-identity' },
        {
          id: 'notify-identity',
          type: 'notify',
          with: {
            channel: '#identity-team',
            template: 'Password spraying against {{alert.user.name}}',
          },
          onFailure: 'continue',
          next: 'ticket',
        },
        { id: 'ticket', type: 'create_ticket', with: { queue: 'IAM', priority: 'low' } },
      ],
    },
  },
];
