import { CreateBackupRequestSchema, StageRestoreRequestSchema } from '@mezon/contracts';
import { type SqliteBackupService } from '@mezon/db-local';
import { DomainError, serializeUnixMs } from '@mezon/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { HubAuthService } from './auth-service.js';

export function registerBackupRoutes(
  app: FastifyInstance,
  authService: HubAuthService,
  backupService: SqliteBackupService,
): void {
  const assertOwner = async (request: FastifyRequest) => {
    const session = await authService.authenticate(request.headers.authorization);
    if (session.user.role !== 'owner') {
      throw new DomainError(
        'AUTH_FORBIDDEN',
        'Zaxira nusxa boshqaruvi faqat biznes egasiga ruxsat etilgan',
      );
    }
    return session;
  };

  // List Backups
  app.get('/backups', async (request) => {
    await assertOwner(request);
    const list = backupService.listBackups();
    return {
      backups: list.map((b) => ({
        id: b.id,
        filename: b.filename,
        sizeBytes: b.sizeBytes,
        createdAtMs: serializeUnixMs(b.createdAtMs),
        sha256: b.sha256,
        reason: b.reason,
        actorUserId: b.actorUserId,
        salesCount: b.salesCount,
        totalNetSales: b.totalNetSalesTiyin.toString(),
      })),
    };
  });

  // Create Manual Backup
  app.post('/backups/create', async (request, reply) => {
    const session = await assertOwner(request);
    const body = CreateBackupRequestSchema.parse(request.body ?? {});
    const meta = await backupService.createBackup({
      reason: body.reason,
      actorUserId: session.user.id,
    });

    return reply.code(201).send({
      backup: {
        id: meta.id,
        filename: meta.filename,
        sizeBytes: meta.sizeBytes,
        createdAtMs: serializeUnixMs(meta.createdAtMs),
        sha256: meta.sha256,
        reason: meta.reason,
        actorUserId: meta.actorUserId,
        salesCount: meta.salesCount,
        totalNetSales: meta.totalNetSalesTiyin.toString(),
      },
    });
  });

  // Stage Restore (R2)
  app.post('/backups/:id/restore', async (request) => {
    const session = await assertOwner(request);
    const { id } = request.params as { readonly id: string };
    const body = StageRestoreRequestSchema.parse(request.body ?? {});

    const res = backupService.stageRestore({
      backupId: id,
      actorUserId: session.user.id,
      reason: body.reason,
    });

    return {
      staged: res.staged,
      backupId: res.backupId,
      requiresRestart: true,
      message:
        'Zaxiradan tiklash muvaffaqiyatli rejalashtirildi. Ilova qayta ishga tushirilganda maʼlumotlar bazasi almashtiriladi.',
    };
  });
}
