/* ============================================================================
   Auto Weight — migrate_v5_more_alert_rules.sql
   ----------------------------------------------------------------------------
   เพิ่มค่า default ใหม่ใน dbo.Settings (ตารางเดิมจาก migrate_v4 รองรับ key-value
   อยู่แล้ว จึงไม่ต้องแก้โครงสร้างตาราง) สำหรับกฎแจ้งเตือนเพิ่มเติมที่ขอ:
     - จำนวน/สัดส่วนค่าที่หลุด Spec ภายในช่วงเวลาย้อนหลัง (ค่าเริ่มต้น 60 นาที)
     - ค่าเฉลี่ยเบี่ยงเบนจาก Target เกินกี่กรัม

   รันแยกได้ (idempotent): sqlcmd -S <DB_SERVER> -d AUTO_WEIGHT -U <user> -P <password> -i migrate_v5_more_alert_rules.sql
   หมายเหตุ: ถ้าไม่ได้รันไฟล์นี้ก็ไม่เป็นไร — พอเข้าหน้า "ตั้งค่า" แล้วกด "บันทึก" ครั้งแรก
   ระบบจะสร้าง key พวกนี้ให้อัตโนมัติอยู่แล้ว ไฟล์นี้แค่ทำให้ค่า default พร้อมใช้งานตั้งแต่ deploy ครั้งแรก
   ============================================================================ */

SET NOCOUNT ON;
USE [AUTO_WEIGHT];
GO

IF NOT EXISTS (SELECT 1 FROM [dbo].[Settings] WHERE [key] = 'alert.oosWindowMin')
    INSERT INTO [dbo].[Settings] ([key],[value]) VALUES ('alert.oosWindowMin', '60');
IF NOT EXISTS (SELECT 1 FROM [dbo].[Settings] WHERE [key] = 'alert.oosMaxCount')
    INSERT INTO [dbo].[Settings] ([key],[value]) VALUES ('alert.oosMaxCount', '3');
IF NOT EXISTS (SELECT 1 FROM [dbo].[Settings] WHERE [key] = 'alert.oosMaxPercent')
    INSERT INTO [dbo].[Settings] ([key],[value]) VALUES ('alert.oosMaxPercent', '5');
IF NOT EXISTS (SELECT 1 FROM [dbo].[Settings] WHERE [key] = 'alert.meanDeviationMax')
    INSERT INTO [dbo].[Settings] ([key],[value]) VALUES ('alert.meanDeviationMax', '2');
GO

PRINT 'Done. เพิ่มเกณฑ์แจ้งเตือน OOS/mean-deviation ใน dbo.Settings แล้ว.';
