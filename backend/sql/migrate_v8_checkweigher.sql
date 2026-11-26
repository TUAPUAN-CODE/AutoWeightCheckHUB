/*
  migrate_v8_checkweigher.sql
  ---------------------------------------------------------------------------
  รองรับเครื่อง Checkweigher (Yamato CE3000 / I-series) ที่ส่งข้อมูลผ่าน OPC UA
  - dbo.Scales.device_type  : 'tcp' (เครื่องชั่ง Spout เดิม) | 'opcua' (checkweigher)
  - dbo.CwPieces            : น้ำหนักรายชิ้น (1 แถว = 1 ชิ้นที่ผ่านเครื่อง) — ใช้คอลัมน์ weight/time_stamp/scale_id/session_id
                              ชื่อเดียวกับตาราง Spout เพื่อให้หน้า Dashboard/ประวัติ/ใบพิมพ์เดิมใช้ได้ทันที
  - dbo.CwSnapshots         : สถิติของเครื่อง (ตัวนับ/Cp/Cpk/ความเร็ว/โปรแกรม) บันทึกทุก 1 นาที
  - dbo.CwEvents            : เหตุการณ์ (เชื่อมต่อ/หลุด, สถานะเครื่อง, เปลี่ยนโปรแกรม, error, ชิ้นหลุด, ล้างยอด)

  รันซ้ำได้ (เช็คก่อนสร้างทุกครั้ง) และไม่แตะข้อมูลเดิม
  ปริมาณข้อมูล: 170 ชิ้น/นาที x 24 ชม. ≈ 245,000 แถว/วัน/เครื่อง (ประมาณ 30 MB/วัน รวม index)
  ถ้าใช้ SQL Server Express (จำกัด 10 GB ต่อฐานข้อมูล) ต้องวางแผน archive/retention ร่วมกับ DBA
*/

SET NOCOUNT ON;
-- filtered index (IX_CwPieces_session) ต้องใช้ 2 ค่านี้ — sqlcmd ปิด QUOTED_IDENTIFIER เป็นค่าเริ่มต้น (หรือรันด้วย sqlcmd -I)
SET QUOTED_IDENTIFIER ON;
SET ANSI_NULLS ON;
GO

/* ---------- 1) dbo.Scales.device_type ---------- */
IF COL_LENGTH('dbo.Scales', 'device_type') IS NULL
BEGIN
    PRINT 'Adding column dbo.Scales.device_type ...';
    ALTER TABLE [dbo].[Scales] ADD [device_type] VARCHAR(20) NOT NULL
        CONSTRAINT DF_Scales_device_type DEFAULT ('tcp') WITH VALUES;
END
ELSE
    PRINT 'Column dbo.Scales.device_type already exists, skip.';
GO

/* ---------- 2) dbo.CwPieces ---------- */
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'CwPieces' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
    PRINT 'Creating table dbo.CwPieces ...';
    CREATE TABLE [dbo].[CwPieces]
    (
        [id]            BIGINT IDENTITY(1,1) NOT NULL,
        [weight]        FLOAT        NOT NULL,   -- กรัม (แปลงจากค่าดิบแล้ว)
        [time_stamp]    DATETIME     NOT NULL,   -- เวลาท้องถิ่นของ server (เหมือนตาราง Spout)
        [scale_id]      INT          NOT NULL,
        [session_id]    BIGINT       NULL,
        [raw_weight]    INT          NULL,       -- ค่าดิบจากเครื่อง (ไม่มีจุดทศนิยม)
        [rank_code]     SMALLINT     NULL,       -- ResultRankCode ของเครื่อง
        [sub_rank_code] SMALLINT     NULL,       -- SubResultRankCode
        [pass_flag]     SMALLINT     NULL,       -- PassFlag ของเครื่อง
        [band]          TINYINT      NULL,       -- ผลเทียบกับ limit ที่ระบบคำนวณ: 0=Accept 1=Over 2=Under 3=HiHi 4=LoLo
        [target_weight] FLOAT        NULL,       -- Target (กรัม) ณ ตอนชั่ง
        [program_no]    SMALLINT     NULL,       -- เลขโปรแกรมสินค้าบนเครื่อง
        [total_count]   INT          NULL,       -- ตัวนับ TotalCount ของเครื่อง ณ ชิ้นนี้
        [gap]           INT          NOT NULL CONSTRAINT DF_CwPieces_gap DEFAULT (0), -- จำนวนชิ้นที่อ่านไม่ทันก่อนหน้าชิ้นนี้
        CONSTRAINT PK_CwPieces PRIMARY KEY CLUSTERED ([id] ASC),
        CONSTRAINT FK_CwPieces_Scale FOREIGN KEY ([scale_id]) REFERENCES [dbo].[Scales]([id]),
        CONSTRAINT FK_CwPieces_Session FOREIGN KEY ([session_id]) REFERENCES [dbo].[Sessions]([id])
    );
END
ELSE
    PRINT 'Table dbo.CwPieces already exists, skip.';
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_CwPieces_scale_time' AND object_id = OBJECT_ID('dbo.CwPieces'))
    CREATE NONCLUSTERED INDEX IX_CwPieces_scale_time ON [dbo].[CwPieces] ([scale_id], [time_stamp])
        INCLUDE ([weight], [rank_code], [band], [target_weight], [gap]);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_CwPieces_session' AND object_id = OBJECT_ID('dbo.CwPieces'))
    CREATE NONCLUSTERED INDEX IX_CwPieces_session ON [dbo].[CwPieces] ([session_id])
        INCLUDE ([weight], [time_stamp]) WHERE [session_id] IS NOT NULL;
GO

/* ---------- 3) dbo.CwSnapshots ---------- */
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'CwSnapshots' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
    PRINT 'Creating table dbo.CwSnapshots ...';
    CREATE TABLE [dbo].[CwSnapshots]
    (
        [id]               BIGINT IDENTITY(1,1) NOT NULL,
        [scale_id]         INT           NOT NULL,
        [time_stamp]       DATETIME      NOT NULL,
        [connected]        BIT           NOT NULL,
        [operation_status] INT           NULL,
        [program_no]       INT           NULL,
        [program_name]     NVARCHAR(100) NULL,
        [speed_setting]    INT           NULL,     -- ชิ้น/นาที ตามโปรแกรม
        [target_weight]    FLOAT         NULL,     -- กรัม
        [hi_limit]         FLOAT         NULL,     -- กรัม (ค่าจริง ไม่ใช่ offset)
        [lo_limit]         FLOAT         NULL,
        [hihi_limit]       FLOAT         NULL,
        [lolo_limit]       FLOAT         NULL,
        [total_count]      INT           NULL,
        [accept_count]     INT           NULL,
        [over_count]       INT           NULL,
        [under_count]      INT           NULL,
        [hihi_count]       INT           NULL,
        [lolo_count]       INT           NULL,
        [metal_count]      INT           NULL,
        [error_count]      INT           NULL,
        [average_weight]   FLOAT         NULL,     -- กรัม (ค่าที่เครื่องคำนวณ)
        [sd_weight]        FLOAT         NULL,
        [machine_cp]       FLOAT         NULL,
        [machine_cpk]      FLOAT         NULL,
        [infeed_speed]     INT           NULL,
        [pass_speed]       INT           NULL,
        [pieces_in_period] INT           NULL,     -- จำนวนชิ้นที่ระบบรับได้ในช่วงนี้
        [gaps_in_period]   INT           NULL,
        CONSTRAINT PK_CwSnapshots PRIMARY KEY CLUSTERED ([id] ASC),
        CONSTRAINT FK_CwSnapshots_Scale FOREIGN KEY ([scale_id]) REFERENCES [dbo].[Scales]([id])
    );
END
ELSE
    PRINT 'Table dbo.CwSnapshots already exists, skip.';
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_CwSnapshots_scale_time' AND object_id = OBJECT_ID('dbo.CwSnapshots'))
    CREATE NONCLUSTERED INDEX IX_CwSnapshots_scale_time ON [dbo].[CwSnapshots] ([scale_id], [time_stamp]);
GO

/* ---------- 4) dbo.CwEvents ---------- */
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'CwEvents' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
    PRINT 'Creating table dbo.CwEvents ...';
    CREATE TABLE [dbo].[CwEvents]
    (
        [id]         BIGINT IDENTITY(1,1) NOT NULL,
        [scale_id]   INT           NOT NULL,
        [time_stamp] DATETIME      NOT NULL,
        [event_type] VARCHAR(30)   NOT NULL,   -- connected | disconnected | status | program | error | gap | stats_cleared
        [severity]   VARCHAR(10)   NOT NULL CONSTRAINT DF_CwEvents_severity DEFAULT ('info'), -- info | warn | alarm
        [detail]     NVARCHAR(400) NULL,
        CONSTRAINT PK_CwEvents PRIMARY KEY CLUSTERED ([id] ASC),
        CONSTRAINT FK_CwEvents_Scale FOREIGN KEY ([scale_id]) REFERENCES [dbo].[Scales]([id])
    );
END
ELSE
    PRINT 'Table dbo.CwEvents already exists, skip.';
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_CwEvents_scale_time' AND object_id = OBJECT_ID('dbo.CwEvents'))
    CREATE NONCLUSTERED INDEX IX_CwEvents_scale_time ON [dbo].[CwEvents] ([scale_id], [time_stamp] DESC);
GO

PRINT 'Done. Checkweigher (OPC UA) tables are ready.';
GO
