import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { PackageRegistration } from './registration.ts';
import type { PackageService } from './service.ts';
import { createPackageInput } from './inputs.ts';
import { repositoryBranchSchema } from './schemas.ts';

const idParams = z.object({ id: z.string().uuid() });
const routeId = (req: FastifyRequest) => idParams.parse(req.params).id;
const discoveryQuery = z.object({ refresh: z.enum(['true','false']).optional() }).strict();
const refreshRequest = z.object({ refresh: z.literal(true), branch: repositoryBranchSchema.optional() }).strict();

interface PackageRoutes {
  packages: PackageService;
  registration: PackageRegistration;
  writable: () => void;
}

export function registerPackageRoutes(app: FastifyInstance, { packages, registration, writable }: PackageRoutes) {
  app.get('/api/repositories', async () => packages.listRepositories());
  app.post('/api/repositories', async req => {
    writable();
    return packages.register(req.body);
  });
  app.get('/api/repositories/:id', async req => packages.repository(routeId(req)));
  app.post('/api/repositories/:id/use-main', async req => {
    writable();
    z.object({}).strict().parse(req.body ?? {});
    return packages.useMain(routeId(req));
  });
  app.patch('/api/repositories/:id/push-settings', async req => {
    writable();
    return packages.setPushSettings(routeId(req), req.body);
  });
  app.post('/api/repositories/:id/push', async req => {
    writable();
    z.object({}).strict().parse(req.body ?? {});
    return packages.requestPush(routeId(req));
  });
  const discover = async (req: FastifyRequest) => {
    if (discoveryQuery.parse(req.query).refresh === 'true') {
      throw Object.assign(new Error('Use POST discover to fetch remote changes.'), { statusCode: 405 });
    }
    return packages.discover(routeId(req));
  };
  app.get('/api/repositories/:id/discover', discover);
  app.get('/api/repositories/:id/discovery', discover);
  app.post('/api/repositories/:id/discover', async req => {
    writable();
    return packages.discover(routeId(req), refreshRequest.parse(req.body));
  });
  app.get('/api/repositories/:id/imports', async req => packages.repositoryImports(routeId(req)));
  app.post('/api/repositories/:id/import', async req => {
    writable();
    return registration.importPackages(routeId(req), req.body);
  });
  app.post('/api/repositories/:id/packages', async req => {
    writable();
    return registration.createPackage(routeId(req), createPackageInput.parse(req.body));
  });
  app.get('/api/packages', async () => packages.listPackages());
  app.get('/api/packages/:id', async req => packages.package(routeId(req)));
  app.get('/api/packages/:id/imports', async req => {
    const record = packages.package(routeId(req));
    return packages.imports(record.id);
  });
}
