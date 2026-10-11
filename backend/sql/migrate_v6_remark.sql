/* ============================================================================
   Auto Weight — migrate_v6_remark.sql
   ----------------------------------------------------------------------------
   เพิ่มคอลัมน์ remark ใน dbo.Sessions — หมายเหตุอิสระที่กรอกตอนเริ่มเอกสาร
   (แสดงในช่อง REMARK ของใบ WEIGHT CHECK RECORD แทนข้อความอัตโนมัติเดิม)

   รันแยกได้ (idempotent): sqlcmd -S <DB_SERVER> -d AUTO_WEIGHT -U <user> -P <password> -i migrate_v6_remark.sql
   ============================================================================ */

SET NOCOUNT ON;
USE [AUTO_WEIGHT];
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Sessions') AND name = 'remark')
    ALTER TABLE [dbo].[Sessions] ADD [remark] NVARCHAR(500) NULL;
GO

-- รหัสฟอร์ม (document control number) ที่พิมพ์บนใบ WEIGHT CHECK RECORD — แก้ได้ทีหลังผ่านหน้า "ตั้งค่า"
IF NOT EXISTS (SELECT 1 FROM [dbo].[Settings] WHERE [key] = 'report.formCode')
    INSERT INTO [dbo].[Settings] ([key],[value]) VALUES ('report.formCode', 'F3QCPFB8-1-01/9/2025');
GO

PRINT 'Done. Sessions.remark และ report.formCode พร้อมใช้งานแล้ว.';
