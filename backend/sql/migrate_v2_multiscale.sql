/* ============================================================================
   Auto Weight — migrate_v2_multiscale.sql
   ----------------------------------------------------------------------------
   เพิ่มความสามารถ "หลายเครื่องชั่ง + เอกสาร (session)" บนฐานข้อมูล AUTO_WEIGHT เดิม
   รันแยกจาก init.sql ได้ (idempotent — รันซ้ำได้ไม่พัง)

   สิ่งที่เพิ่ม:
     1) dbo.Scales      — ทะเบียนเครื่องชั่งทั้งหมด (ip/port/line/S-N/สถานะเปิดใช้งาน)
     2) dbo.Sessions    — "เอกสาร" 1 รอบ เริ่ม-หยุด ของเครื่องชั่ง 1 เครื่อง + code ที่เลือก
     3) dbo.Auto        — เพิ่มคอลัมน์ scale_id, session_id (nullable, ไม่กระทบข้อมูลเดิม)
                          เพื่อให้ทุกค่าน้ำหนักอยู่ "ตารางเดียว" (ตามที่ตกลง — ง่ายต่อการ query/ดัชนี
                          รองรับ 13+ เครื่องได้สบายถ้ามีดัชนีที่เหมาะสม) แต่ยังสืบย้อนได้ว่า
                          แต่ละค่ามาจากเครื่องไหน และอยู่ใน "เอกสาร" ไหน

   วิธีรัน: sqlcmd -S <DB_SERVER> -d AUTO_WEIGHT -U <user> -P <password> -i migrate_v2_multiscale.sql
   ============================================================================ */

SET NOCOUNT ON;
USE [AUTO_WEIGHT];
GO

/* ---------- 1) dbo.Scales — ทะเบียนเครื่องชั่ง ---------- */
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'Scales' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
    PRINT 'Creating table dbo.Scales ...';
    CREATE TABLE [dbo].[Scales]
    (
        [id]          INT IDENTITY(1,1) NOT NULL,
        [name]        NVARCHAR(100)     NOT NULL,      -- ชื่อที่แสดงผล เช่น "เครื่องชั่ง 1"
        [ip]          VARCHAR(45)       NOT NULL,
        [port]        INT               NOT NULL,
        [line]        NVARCHAR(50)      NULL,           -- ไลน์ผลิต เช่น "Line 3"
        [serial_no]   NVARCHAR(100)     NULL,           -- S/N เครื่องชั่ง
        [enabled]     BIT               NOT NULL CONSTRAINT DF_Scales_enabled DEFAULT (1),
        [note]        NVARCHAR(255)     NULL,
        [created_at]  DATETIME          NOT NULL CONSTRAINT DF_Scales_created_at DEFAULT (GETDATE()),
        [updated_at]  DATETIME          NOT NULL CONSTRAINT DF_Scales_updated_at DEFAULT (GETDATE()),
        CONSTRAINT PK_Scales PRIMARY KEY CLUSTERED ([id] ASC),
        CONSTRAINT UQ_Scales_ip_port UNIQUE ([ip], [port])
    );
END
ELSE
    PRINT 'Table dbo.Scales already exists, skip.';
GO

/* ---------- 2) dbo.Sessions — "เอกสาร" เริ่ม/หยุด ---------- */
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'Sessions' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
    PRINT 'Creating table dbo.Sessions ...';
    CREATE TABLE [dbo].[Sessions]
    (
        [id]                 BIGINT IDENTITY(1,1) NOT NULL,
        [scale_id]           INT            NOT NULL,
        [group_code]         NVARCHAR(50)   NOT NULL,
        [product_code]       NVARCHAR(50)   NOT NULL,

        -- snapshot ของ spec ตอนเริ่ม (กันปัญหา spec เปลี่ยนทีหลังแล้วประวัติเก่าถูกตีความใหม่)
        [fw_target] FLOAT NULL, [fw_ucl] FLOAT NULL, [fw_uwl] FLOAT NULL, [fw_lwl] FLOAT NULL, [fw_lcl] FLOAT NULL,
        [nw_target] FLOAT NULL, [nw_ucl] FLOAT NULL, [nw_uwl] FLOAT NULL, [nw_lwl] FLOAT NULL, [nw_lcl] FLOAT NULL,

        [start_time]         DATETIME       NOT NULL,
        [end_time]           DATETIME       NULL,
        [status]             VARCHAR(20)    NOT NULL CONSTRAINT DF_Sessions_status DEFAULT ('running'), -- running | completed | aborted

        -- กะ/วันที่รายงาน ของ start_time (DS 06:00-17:30 / NS 17:30-06:00 นับเป็นวันของกะ DS ก่อนหน้า)
        [shift]              VARCHAR(2)     NULL,        -- DS | NS
        [report_date]        DATE           NULL,

        -- สรุปผล คำนวณตอนกดหยุด จากค่าน้ำหนักทั้งหมดที่ session_id นี้
        [reading_count]      INT            NULL,
        [avg_weight]         FLOAT          NULL,
        [min_weight]         FLOAT          NULL,
        [max_weight]         FLOAT          NULL,
        [out_of_spec_count]  INT            NULL,

        [created_at]         DATETIME       NOT NULL CONSTRAINT DF_Sessions_created_at DEFAULT (GETDATE()),

        CONSTRAINT PK_Sessions PRIMARY KEY CLUSTERED ([id] ASC),
        CONSTRAINT FK_Sessions_Scale FOREIGN KEY ([scale_id]) REFERENCES [dbo].[Scales]([id])
    );
END
ELSE
    PRINT 'Table dbo.Sessions already exists, skip.';
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Sessions_scale_start' AND object_id = OBJECT_ID('dbo.Sessions'))
    CREATE NONCLUSTERED INDEX IX_Sessions_scale_start ON [dbo].[Sessions] ([scale_id], [start_time] DESC);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Sessions_report_date' AND object_id = OBJECT_ID('dbo.Sessions'))
    CREATE NONCLUSTERED INDEX IX_Sessions_report_date ON [dbo].[Sessions] ([report_date], [shift]);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Sessions_status' AND object_id = OBJECT_ID('dbo.Sessions'))
    CREATE NONCLUSTERED INDEX IX_Sessions_status ON [dbo].[Sessions] ([status]) WHERE [status] = 'running';
GO

/* ---------- 3) dbo.Auto — เพิ่ม scale_id / session_id ---------- */
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Auto') AND name = 'scale_id')
BEGIN
    PRINT 'Adding column Auto.scale_id ...';
    ALTER TABLE [dbo].[Auto] ADD [scale_id] INT NULL;
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Auto') AND name = 'session_id')
BEGIN
    PRINT 'Adding column Auto.session_id ...';
    ALTER TABLE [dbo].[Auto] ADD [session_id] BIGINT NULL;
END
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_Auto_Scale'
)
BEGIN
    ALTER TABLE [dbo].[Auto] WITH NOCHECK
        ADD CONSTRAINT FK_Auto_Scale FOREIGN KEY ([scale_id]) REFERENCES [dbo].[Scales]([id]);
END
GO
IF NOT EXISTS (
    SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_Auto_Session'
)
BEGIN
    ALTER TABLE [dbo].[Auto] WITH NOCHECK
        ADD CONSTRAINT FK_Auto_Session FOREIGN KEY ([session_id]) REFERENCES [dbo].[Sessions]([id]);
END
GO

/* ดัชนีสำคัญที่สุด — ใช้ทั้งหน้า monitor (ค่าล่าสุดของเครื่องนั้น) และหน้ากราฟ (ค่าทั้งหมดของ session) */
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Auto_scale_time' AND object_id = OBJECT_ID('dbo.Auto'))
    CREATE NONCLUSTERED INDEX IX_Auto_scale_time ON [dbo].[Auto] ([scale_id], [time_stamp] DESC) INCLUDE ([weight]);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Auto_session' AND object_id = OBJECT_ID('dbo.Auto'))
    CREATE NONCLUSTERED INDEX IX_Auto_session ON [dbo].[Auto] ([session_id]) INCLUDE ([weight], [time_stamp]) WHERE [session_id] IS NOT NULL;
GO

/* ---------- 4) seed เครื่องชั่งตัวแรกจากค่าที่เคยอยู่ใน .env (DEVICE_IP/DEVICE_PORT) ---------- */
-- แก้ ip/port/line/serial_no ตรงนี้ให้ตรงเครื่องจริงก่อนรัน หรือจะลบ block นี้แล้วเพิ่มเองผ่านหน้า Monitor ก็ได้
IF NOT EXISTS (SELECT 1 FROM [dbo].[Scales] WHERE [ip] = '172.48.2.175' AND [port] = 1052)
BEGIN
    INSERT INTO [dbo].[Scales] ([name], [ip], [port], [line], [serial_no], [enabled])
    VALUES (N'เครื่องชั่ง 1', '172.48.2.175', 1052, N'Line 1', NULL, 1);
END
GO

PRINT 'Done. Scales / Sessions พร้อมใช้งาน, Auto มี scale_id/session_id แล้ว.';
