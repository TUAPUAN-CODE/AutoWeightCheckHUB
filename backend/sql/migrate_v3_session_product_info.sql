/* ============================================================================
   Auto Weight — migrate_v3_session_product_info.sql
   ----------------------------------------------------------------------------
   เพิ่มคอลัมน์ snapshot ข้อมูลสินค้า (Package/PackageName/Customer/Destination/LabelInk)
   ลงใน dbo.Sessions เพื่อให้หน้าใบพิมพ์ WEIGHT CHECK RECORD และหน้ารายละเอียดเอกสาร
   แสดง SIZE / CUSTOMER ได้จริง โดยไม่ต้อง query กลับไปที่ DB ตัวที่สอง (WC) ทุกครั้ง
   (เหมือน spec FW/NW เดิมที่ snapshot ไว้ตอนเริ่มเอกสารอยู่แล้ว)

   รันแยกจาก migrate_v2_multiscale.sql ได้ (idempotent — รันซ้ำได้ไม่พัง)
   วิธีรัน: sqlcmd -S <DB_SERVER> -d AUTO_WEIGHT -U <user> -P <password> -i migrate_v3_session_product_info.sql
   ============================================================================ */

SET NOCOUNT ON;
USE [AUTO_WEIGHT];
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Sessions') AND name = 'package')
    ALTER TABLE [dbo].[Sessions] ADD [package] NVARCHAR(100) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Sessions') AND name = 'package_name')
    ALTER TABLE [dbo].[Sessions] ADD [package_name] NVARCHAR(200) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Sessions') AND name = 'customer')
    ALTER TABLE [dbo].[Sessions] ADD [customer] NVARCHAR(200) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Sessions') AND name = 'destination')
    ALTER TABLE [dbo].[Sessions] ADD [destination] NVARCHAR(200) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Sessions') AND name = 'label_ink')
    ALTER TABLE [dbo].[Sessions] ADD [label_ink] NVARCHAR(50) NULL;
GO

PRINT 'Done. Sessions มีคอลัมน์ package/package_name/customer/destination/label_ink แล้ว.';
