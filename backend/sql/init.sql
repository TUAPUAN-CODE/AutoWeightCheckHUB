/* ============================================================================
   Auto Weight — init.sql
   ----------------------------------------------------------------------------
   สร้างฐานข้อมูล/ตาราง/ผู้ใช้ ให้ตรงกับสิ่งที่ backend (backend/src/db.js) อ่าน-เขียนจริง:
     - INSERT INTO [dbo].[Auto] ([weight], [time_stamp]) VALUES (...)
     - SELECT id, weight, time_stamp ... ORDER BY id / WHERE id > @sinceId / time_stamp BETWEEN
     - id ถูกอ้างเป็นเลขจำนวนเต็ม (identity, auto-increment) — ไม่ต้องส่งตอน insert
     - weight เป็นเลขทศนิยม (backend bind เป็น FLOAT)
     - time_stamp เป็นเวลาท้องถิ่นแบบไม่มี timezone (DB_USE_UTC=false ค่า default)

   วิธีรัน (เลือกอย่างใดอย่างหนึ่ง):
     1) เปิดใน SSMS / Azure Data Studio แล้ว Execute (F5)
     2) sqlcmd -S <DB_SERVER> -U <admin_user> -P <admin_password> -i init.sql

   ต้องรันด้วย login ที่มีสิทธิ์ CREATE DATABASE / CREATE LOGIN (เช่น sa หรือ admin ที่ DBA ให้มา)
   ตัวแปรด้านล่างให้แก้ให้ตรงกับค่าที่ตั้งไว้ใน .env (DB_NAME / DB_USER / DB_PASSWORD)
   ============================================================================ */

SET NOCOUNT ON;

/* ---------- 1) ฐานข้อมูล ---------- */
IF DB_ID(N'AUTO_WEIGHT') IS NULL
BEGIN
    PRINT 'Creating database AUTO_WEIGHT ...';
    CREATE DATABASE [AUTO_WEIGHT];
END
ELSE
    PRINT 'Database AUTO_WEIGHT already exists, skip.';
GO

USE [AUTO_WEIGHT];
GO

/* ---------- 2) ตาราง Auto (id, weight, time_stamp) ---------- */
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'Auto' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
    PRINT 'Creating table dbo.Auto ...';
    CREATE TABLE [dbo].[Auto]
    (
        [id]         INT IDENTITY(1,1) NOT NULL,
        [weight]     FLOAT             NOT NULL,
        [time_stamp] DATETIME          NOT NULL CONSTRAINT DF_Auto_time_stamp DEFAULT (GETDATE()),
        CONSTRAINT PK_Auto PRIMARY KEY CLUSTERED ([id] ASC)
    );
END
ELSE
    PRINT 'Table dbo.Auto already exists, skip.';
GO

/* index ตาม time_stamp — ใช้เร่ง GET /api/weights/range (WHERE time_stamp BETWEEN ...) */
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'IX_Auto_time_stamp' AND object_id = OBJECT_ID('dbo.Auto')
)
BEGIN
    PRINT 'Creating index IX_Auto_time_stamp ...';
    CREATE NONCLUSTERED INDEX IX_Auto_time_stamp ON [dbo].[Auto] ([time_stamp]);
END
GO

/* ---------- 3) Login + User สำหรับ backend (ตรงกับ DB_USER/DB_PASSWORD ใน .env) ---------- */
IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'dbthanapat')
BEGIN
    PRINT 'Creating login dbthanapat ...';
    CREATE LOGIN [dbthanapat] WITH PASSWORD = N'240630zA!!', CHECK_POLICY = OFF;
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'dbthanapat')
BEGIN
    PRINT 'Creating user dbthanapat in AUTO_WEIGHT ...';
    CREATE USER [dbthanapat] FOR LOGIN [dbthanapat];
END
GO

/* สิทธิ์อ่าน/เขียนพอสำหรับ endpoint ที่ backend ใช้ (SELECT + INSERT) — ไม่ให้สิทธิ์ DELETE/DDL */
ALTER ROLE db_datareader ADD MEMBER [dbthanapat];
ALTER ROLE db_datawriter ADD MEMBER [dbthanapat];
GO

PRINT 'Done. ตาราง dbo.Auto และ user dbthanapat พร้อมใช้งานแล้ว.';
