import type { ManagedService } from '../managed/service.ts';
import type { ConnectorService } from '../connectors/service.ts';
import type { CreatePackageInput } from './inputs.ts';
import type { PackageRecord } from './schemas.ts';

type SkillRegistration = { notice?: string; name: string } | undefined;

/** Both owner HTTP requests and operator tools register the same imported revision. */
export class PackageRegistration {
  constructor(
    private managed: ManagedService,
    private connectors: ConnectorService,
    private registerSkill: (record: PackageRecord) => Promise<SkillRegistration>,
  ) {}

  async register(record: PackageRecord) {
    try {
      await this.managed.materializePackage(record);
      if (record.kind === 'connector') {
        return { connection: await this.connectors.registerProject(record.id) };
      }
      if (record.kind === 'skill') {
        const skill = await this.registerSkill(record);
        return { skill, ...(skill?.notice ? { notice: skill.notice } : {}) };
      }
      return {};
    } catch (error) {
      return { notice: `Source imported; runtime registration needs attention: ${(error as Error).message}` };
    }
  }

  async createPackage(repositoryId: string, input: CreatePackageInput, runId?: string) {
    const record = await this.managed.createPackage(repositoryId, input);
    this.managed.trackPackage(record.id, runId);
    return { ...record, ...await this.register(record) };
  }

  async importPackages(repositoryId: string, input: unknown, runId?: string) {
    const result = await this.managed.packages.importPackages(repositoryId, input);
    const registrations = [];
    for (const record of result.packages) {
      this.managed.trackPackage(record.id, runId);
      registrations.push({ packageId: record.id, ...await this.register(record) });
    }
    return { ...result, registrations };
  }
}
