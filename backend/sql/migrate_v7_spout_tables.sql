/* ============================================================================
   Auto Weight — migrate_v7_spout_tables.sql
   ----------------------------------------------------------------------------
   สร้างตาราง Spout 1 / Spout 2 / Spout 3 ที่ backend (scale-reader.js: SPOUT_TABLE_BY_IP)
   คาดหวังว่ามีอยู่แล้วสำหรับแยกเก็บค่าน้ำหนักตาม IP เครื่องชั่ง — ตารางเหล่านี้ไม่เคยถูกสร้าง
   จริงบน SQL Server ทำให้ insert พังทุกครั้งด้วย error "Invalid object name 'dbo.Spout 3'"
   (total_insert_failed สูงขึ้นเรื่อย ๆ, ค่าน้ำหนักเลยไม่เคย persist ไปที่ dashboard/history)

   โครงสร้างคอลัมน์เหมือน dbo.Auto หลัง migrate_v2_multiscale.sql ทุกประการ
   (id, weight, time_stamp, scale_id, session_id) เพราะ db.js:insertWeight() /
   fetchRecent() / fetchHistory() / fetchSince() / fetchRange() / fetchWeightsBySession()
   ใช้ query รูปแบบเดียวกันกับทุกตารางที่อยู่ใน ALLOWED_TABLES

   รันหลัง migrate_v2_multiscale.sql (ต้องมี dbo.Scales / dbo.Sessions อยู่แล้ว)
   วิธีรัน: sqlcmd -S <DB_SERVER> -d AUTO_WEIGHT -U <user> -P <password> -i migrate_v7_spout_tables.sql
   ============================================================================ */

SET NOCOUNT ON;
USE [AUTO_WEIGHT];
GO

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'Spout 1' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
    PRINT 'Creating table [dbo].[Spout 1] ...';
    CREATE TABLE [dbo].[Spout 1]
    (
        [id]         INT IDENTITY(1,1) NOT NULL,
        [weight]     FLOAT             NOT NULL,
        [time_stamp] DATETIME          NOT NULL CONSTRAINT [DF_Spout1_time_stamp] DEFAULT (GETDATE()),
        [scale_id]   INT               NULL,
        [session_id] BIGINT            NULL,
        CONSTRAINT [PK_Spout1] PRIMARY KEY CLUSTERED ([id] ASC)
    );
END
ELSE
    PRINT 'Table [dbo].[Spout 1] already exists, skip.';
GO

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'Spout 2' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
    PRINT 'Creating table [dbo].[Spout 2] ...';
    CREATE TABLE [dbo].[Spout 2]
    (
        [id]         INT IDENTITY(1,1) NOT NULL,
        [weight]     FLOAT             NOT NULL,
        [time_stamp] DATETIME          NOT NULL CONSTRAINT [DF_Spout2_time_stamp] DEFAULT (GETDATE()),
        [scale_id]   INT               NULL,
        [session_id] BIGINT            NULL,
        CONSTRAINT [PK_Spout2] PRIMARY KEY CLUSTERED ([id] ASC)
    );
END
ELSE
    PRINT 'Table [dbo].[Spout 2] already exists, skip.';
GO

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'Spout 3' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
    PRINT 'Creating table [dbo].[Spout 3] ...';
    CREATE TABLE [dbo].[Spout 3]
    (
        [id]         INT IDENTITY(1,1) NOT NULL,
        [weight]     FLOAT             NOT NULL,
        [time_stamp] DATETIME          NOT NULL CONSTRAINT [DF_Spout3_time_stamp] DEFAULT (GETDATE()),
        [scale_id]   INT               NULL,
        [session_id] BIGINT            NULL,
        CONSTRAINT [PK_Spout3] PRIMARY KEY CLUSTERED ([id] ASC)
    );
END
ELSE
    PRINT 'Table [dbo].[Spout 3] already exists, skip.';
GO

/* FK ไป Scales/Sessions (ใช้ NOCHECK กันกรณีมีข้อมูลเก่าที่ scale_id/session_id ไม่ตรง — เหมือนที่ทำกับ Auto ใน v2) */
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_Spout1_Scale')
    ALTER TABLE [dbo].[Spout 1] WITH NOCHECK ADD CONSTRAINT [FK_Spout1_Scale] FOREIGN KEY ([scale_id]) REFERENCES [dbo].[Scales]([id]);
GO
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_Spout1_Session')
    ALTER TABLE [dbo].[Spout 1] WITH NOCHECK ADD CONSTRAINT [FK_Spout1_Session] FOREIGN KEY ([session_id]) REFERENCES [dbo].[Sessions]([id]);
GO
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_Spout2_Scale')
    ALTER TABLE [dbo].[Spout 2] WITH NOCHECK ADD CONSTRAINT [FK_Spout2_Scale] FOREIGN KEY ([scale_id]) REFERENCES [dbo].[Scales]([id]);
GO
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_Spout2_Session')
    ALTER TABLE [dbo].[Spout 2] WITH NOCHECK ADD CONSTRAINT [FK_Spout2_Session] FOREIGN KEY ([session_id]) REFERENCES [dbo].[Sessions]([id]);
GO
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_Spout3_Scale')
    ALTER TABLE [dbo].[Spout 3] WITH NOCHECK ADD CONSTRAINT [FK_Spout3_Scale] FOREIGN KEY ([scale_id]) REFERENCES [dbo].[Scales]([id]);
GO
IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_Spout3_Session')
    ALTER TABLE [dbo].[Spout 3] WITH NOCHECK ADD CONSTRAINT [FK_Spout3_Session] FOREIGN KEY ([session_id]) REFERENCES [dbo].[Sessions]([id]);
GO

/* ดัชนี — เหมือนที่ Auto มี (IX_Auto_scale_time / IX_Auto_session) ใช้ทั้งหน้า monitor และหน้ากราฟ */
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Spout1_scale_time' AND object_id = OBJECT_ID('[dbo].[Spout 1]'))
    CREATE NONCLUSTERED INDEX [IX_Spout1_scale_time] ON [dbo].[Spout 1] ([scale_id], [time_stamp] DESC) INCLUDE ([weight]);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Spout1_session' AND object_id = OBJECT_ID('[dbo].[Spout 1]'))
    CREATE NONCLUSTERED INDEX [IX_Spout1_session] ON [dbo].[Spout 1] ([session_id]) INCLUDE ([weight], [time_stamp]) WHERE [session_id] IS NOT NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Spout2_scale_time' AND object_id = OBJECT_ID('[dbo].[Spout 2]'))
    CREATE NONCLUSTERED INDEX [IX_Spout2_scale_time] ON [dbo].[Spout 2] ([scale_id], [time_stamp] DESC) INCLUDE ([weight]);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Spout2_session' AND object_id = OBJECT_ID('[dbo].[Spout 2]'))
    CREATE NONCLUSTERED INDEX [IX_Spout2_session] ON [dbo].[Spout 2] ([session_id]) INCLUDE ([weight], [time_stamp]) WHERE [session_id] IS NOT NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Spout3_scale_time' AND object_id = OBJECT_ID('[dbo].[Spout 3]'))
    CREATE NONCLUSTERED INDEX [IX_Spout3_scale_time] ON [dbo].[Spout 3] ([scale_id], [time_stamp] DESC) INCLUDE ([weight]);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Spout3_session' AND object_id = OBJECT_ID('[dbo].[Spout 3]'))
    CREATE NONCLUSTERED INDEX [IX_Spout3_session] ON [dbo].[Spout 3] ([session_id]) INCLUDE ([weight], [time_stamp]) WHERE [session_id] IS NOT NULL;
GO

/* สิทธิ์ให้ user backend ใช้งานตารางใหม่ได้ด้วย (ชื่อ login เดียวกับที่ init.sql สร้างไว้) */
IF EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'dbthanapat')
BEGIN
    GRANT SELECT, INSERT ON [dbo].[Spout 1] TO [dbthanapat];
    GRANT SELECT, INSERT ON [dbo].[Spout 2] TO [dbthanapat];
    GRANT SELECT, INSERT ON [dbo].[Spout 3] TO [dbthanapat];
END
GO

PRINT 'Done. [dbo].[Spout 1] / [Spout 2] / [Spout 3] พร้อมใช้งานแล้ว — insert จากเครื่องชั่งจะไม่ error Invalid object name อีกต่อไป.';
