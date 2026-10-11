"""
Auto Weight Backend
====================
อ่านข้อมูลน้ำหนักจากเครื่องชั่งผ่าน TCP (เหมือนที่ Hercules SETUP utility ต่อได้)
แล้ว insert ลงตาราง Auto (id, weight, time_stamp) ที่มีอยู่แล้วใน SQL Server
โดยไม่แก้โครงสร้างตารางเดิม

รันด้วย:
    uvicorn main:app --host 0.0.0.0 --port 8000

ตั้งค่าผ่าน environment variables (หรือแก้ในไฟล์ .env):
    DEVICE_IP        - IP ของเครื่องชั่ง/โมดูล (ตัวอย่าง 192.168.1.111)
    DEVICE_PORT      - Port TCP (ตัวอย่าง 1052)
    DB_SERVER        - SQL Server host (ตัวอย่าง localhost หรือ 192.168.x.x)
    DB_NAME          - ชื่อฐานข้อมูล (AUTO_WEIGHT)
    DB_USER          - PFCMv2
    DB_PASSWORD      - 987654321.Com
"""

import os
import re
import socket
import threading
import time
import logging
from datetime import datetime
from contextlib import asynccontextmanager

import pymssql
from fastapi import FastAPI
from fastapi.responses import JSONResponse

try:
    from dotenv import load_dotenv
    load_dotenv()  # โหลดค่าจากไฟล์ .env ถ้ามี (ไม่มีก็ไม่ error)
except ImportError:
    pass

# --------------------------------------------------------------------------
# Config (แก้ผ่าน environment variables ได้ ไม่ต้องแก้โค้ด)
# --------------------------------------------------------------------------
DEVICE_IP = os.getenv("DEVICE_IP", "192.168.1.111")
DEVICE_PORT = int(os.getenv("DEVICE_PORT", "1052"))

DB_SERVER = os.getenv("DB_SERVER", "localhost")
DB_NAME = os.getenv("DB_NAME", "AUTO_WEIGHT")
DB_USER = os.getenv("DB_USER", "PFCMv2")
DB_PASSWORD = os.getenv("DB_PASSWORD", "987654321.Com")

RECONNECT_DELAY_SEC = 5          # รอกี่วินาทีก่อนลองต่อ TCP ใหม่หลังหลุด
SOCKET_TIMEOUT_SEC = 30          # ถ้าไม่มีข้อมูลเข้ามาเกินนี้ ถือว่า connection ตาย
MIN_INSERT_INTERVAL_SEC = 0.0    # ตั้ง >0 ถ้าอยากกันไม่ให้ insert ถี่เกินไป (debounce)

# รูปแบบข้อความจากเครื่องชั่ง เช่น:
#   GW+ 0052.5 g,cx11,
#   07GW+ 0045.5 g,cx11,
#   01GW+ 0072.7 g,cx12,
# ดึงเฉพาะตัวเลขน้ำหนักหลัง GW+ (มีหรือไม่มี prefix ตัวเลขนำหน้าก็ match ได้)
WEIGHT_PATTERN = re.compile(r"GW\+\s*(-?\d+\.\d+)\s*g")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("weight_backend")


# --------------------------------------------------------------------------
# Database
# --------------------------------------------------------------------------
def get_db_connection():
    """เปิด connection ใหม่ทุกครั้งที่ insert (ปลอดภัยสุดสำหรับงานที่ insert ไม่ถี่มาก)"""
    return pymssql.connect(
        server=DB_SERVER,
        user=DB_USER,
        password=DB_PASSWORD,
        database=DB_NAME,
        timeout=10,
        login_timeout=10,
    )


def insert_weight(weight: float) -> None:
    """Insert 1 แถวลงตาราง Auto(id, weight, time_stamp) - id เป็น identity, time_stamp ใส่เวลาปัจจุบัน"""
    conn = None
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO [dbo].[Auto] (weight, time_stamp) VALUES (%s, %s)",
            (weight, datetime.now()),
        )
        conn.commit()
        logger.info(f"Inserted weight={weight} g")
    except Exception as e:
        logger.error(f"DB insert failed for weight={weight}: {e}")
    finally:
        if conn is not None:
            conn.close()


# --------------------------------------------------------------------------
# TCP reader (background thread)
# --------------------------------------------------------------------------
class WeightReader:
    def __init__(self):
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self.status = "stopped"
        self.last_weight: float | None = None
        self.last_received_at: datetime | None = None
        self.total_received = 0
        self.last_error: str | None = None

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self):
        self._stop_event.set()
        self.status = "stopped"

    def _run(self):
        buffer = ""
        while not self._stop_event.is_set():
            sock = None
            try:
                self.status = "connecting"
                logger.info(f"Connecting to {DEVICE_IP}:{DEVICE_PORT} ...")
                sock = socket.create_connection(
                    (DEVICE_IP, DEVICE_PORT), timeout=SOCKET_TIMEOUT_SEC
                )
                sock.settimeout(SOCKET_TIMEOUT_SEC)
                self.status = "connected"
                self.last_error = None
                logger.info(f"Connected to {DEVICE_IP}:{DEVICE_PORT}")

                while not self._stop_event.is_set():
                    try:
                        data = sock.recv(4096)
                    except socket.timeout:
                        logger.warning("Socket read timeout, reconnecting...")
                        break

                    if not data:
                        logger.warning("Connection closed by device, reconnecting...")
                        break

                    buffer += data.decode(errors="ignore")

                    # ดึงทุก weight ที่เจอในบัฟเฟอร์ ณ ตอนนี้
                    matches = list(WEIGHT_PATTERN.finditer(buffer))
                    if matches:
                        for m in matches:
                            weight = float(m.group(1))
                            self.last_weight = weight
                            self.last_received_at = datetime.now()
                            self.total_received += 1
                            insert_weight(weight)

                        # เก็บเฉพาะส่วนที่ยังไม่ผ่าน match สุดท้าย ไว้กันข้อมูลขาดตอน
                        buffer = buffer[matches[-1].end():]

                    # กันบัฟเฟอร์บวมถ้าไม่มี pattern ตรงเลยเป็นเวลานาน
                    if len(buffer) > 8192:
                        buffer = buffer[-2048:]

            except Exception as e:
                self.status = "error"
                self.last_error = str(e)
                logger.error(f"Connection error: {e}")
            finally:
                if sock is not None:
                    sock.close()

            if not self._stop_event.is_set():
                self.status = "reconnecting"
                time.sleep(RECONNECT_DELAY_SEC)


reader = WeightReader()


# --------------------------------------------------------------------------
# FastAPI app
# --------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    reader.start()
    yield
    reader.stop()


app = FastAPI(title="Auto Weight Backend", lifespan=lifespan)


@app.get("/status")
def get_status():
    return JSONResponse(
        {
            "device": f"{DEVICE_IP}:{DEVICE_PORT}",
            "connection_status": reader.status,
            "last_weight": reader.last_weight,
            "last_received_at": (
                reader.last_received_at.isoformat()
                if reader.last_received_at
                else None
            ),
            "total_received": reader.total_received,
            "last_error": reader.last_error,
        }
    )


@app.post("/start")
def start_reader():
    reader.start()
    return {"message": "reader started"}


@app.post("/stop")
def stop_reader():
    reader.stop()
    return {"message": "reader stopped"}


@app.get("/recent")
def get_recent(limit: int = 20):
    """ดึงข้อมูลล่าสุดจากตาราง Auto มาแสดง (สำหรับเช็คว่า insert เข้าจริงไหม)"""
    conn = None
    try:
        conn = get_db_connection()
        cursor = conn.cursor(as_dict=True)
        cursor.execute(
            f"SELECT TOP ({int(limit)}) [id], [weight], [time_stamp] "
            f"FROM [dbo].[Auto] ORDER BY [id] DESC"
        )
        rows = cursor.fetchall()
        return {"rows": rows}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)
    finally:
        if conn is not None:
            conn.close()


@app.get("/")
def root():
    return {
        "message": "Auto Weight Backend is running",
        "endpoints": ["/status", "/recent", "/start", "/stop"],
    }
