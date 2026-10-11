/* ============================================================================
   Auto Weight — migrate_v4_inspector_and_settings.sql
   ----------------------------------------------------------------------------
   1) เพิ่มคอลัมน์ inspector_name ใน dbo.Sessions (ชื่อผู้ตรวจสอบตอนเริ่มเอกสาร)
   2) สร้างตาราง dbo.Settings (key-value) เก็บค่า threshold แจ้งเตือน CP/CPK/PPK
      และค่า config อื่น ๆ ของระบบ ปรับได้จากหน้า "ตั้งค่า" (config.html)

   รันแยกได้ (idempotent): sqlcmd -S <DB_SERVER> -d AUTO_WEIGHT -U <user> -P <password> -i migrate_v4_inspector_and_settings.sql
   ============================================================================ */

SET NOCOUNT ON;
USE [AUTO_WEIGHT];
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Sessions') AND name = 'inspector_name')
    ALTER TABLE [dbo].[Sessions] ADD [inspector_name] NVARCHAR(100) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'Settings' AND schema_id = SCHEMA_ID('dbo'))
BEGIN
    CREATE TABLE [dbo].[Settings]
    (
        [key]        NVARCHAR(100) NOT NULL,
        [value]      NVARCHAR(MAX) NULL,
        [updated_at] DATETIME      NOT NULL CONSTRAINT DF_Settings_updated_at DEFAULT (GETDATE()),
        CONSTRAINT PK_Settings PRIMARY KEY CLUSTERED ([key] ASC)
    );
END
GO

-- ค่าเริ่มต้น (แก้ได้ทีหลังผ่านหน้า "ตั้งค่า" — INSERT เฉพาะถ้ายังไม่มี ไม่ทับของเดิม)
IF NOT EXISTS (SELECT 1 FROM [dbo].[Settings] WHERE [key] = 'alert.cpMin')
    INSERT INTO [dbo].[Settings] ([key],[value]) VALUES ('alert.cpMin', '1.00');
IF NOT EXISTS (SELECT 1 FROM [dbo].[Settings] WHERE [key] = 'alert.cpkMin')
    INSERT INTO [dbo].[Settings] ([key],[value]) VALUES ('alert.cpkMin', '1.00');
IF NOT EXISTS (SELECT 1 FROM [dbo].[Settings] WHERE [key] = 'alert.ppkMin')
    INSERT INTO [dbo].[Settings] ([key],[value]) VALUES ('alert.ppkMin', '1.00');
IF NOT EXISTS (SELECT 1 FROM [dbo].[Settings] WHERE [key] = 'alert.soundEnabled')
    INSERT INTO [dbo].[Settings] ([key],[value]) VALUES ('alert.soundEnabled', 'true');
IF NOT EXISTS (SELECT 1 FROM [dbo].[Settings] WHERE [key] = 'security.historyEditPassword')
    INSERT INTO [dbo].[Settings] ([key],[value]) VALUES ('security.historyEditPassword', '172480116');
GO

PRINT 'Done. Sessions.inspector_name และ dbo.Settings พร้อมใช้งานแล้ว.';
