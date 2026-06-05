// Server

const express    = require('express');
const cors       = require('cors');
const bodyParser = require('body-parser');
const sql        = require('mssql');

const app = express();
app.use(cors());
app.use(bodyParser.json());

const dbConfig = {
    user: 'sa',
    password: 'C0NTR453N1!4',
    server: '127.0.0.1',
    database: 'arcade_db',
    port: 1433,
    options: { encrypt: false, trustServerCertificate: true }
};

// Buzon: guarda al ultimo jugador que escaneo
let buzon = { id_rfid: "--------", usr: "Esperando...", score: 0, name_disp: "Ninguno" };

// ── 1. POST: recibe el score del juego Python y guarda solo el maximo ──
app.post('/api/puntuaciones', async (req, res) => {
    const { id_rfid, usr, score, name_disp } = req.body;
    console.log(`[POST] RFID: ${id_rfid} | Score: ${score} | Usuario: ${usr}`);

    try {
        let pool = await sql.connect(dbConfig);
        let result = await pool.request()
            .input('id_rfid', sql.VarChar, id_rfid)
            .query(`SELECT TOP 1 ID, SCORE FROM puntuaciones WHERE ID_RFID = @id_rfid ORDER BY ID ASC`);
            //       ^^^^^^ trae la PK     ^^^^^^ TOP 1 evita procesar duplicados accidentales

        if (result.recordset.length > 0) {
            const { ID: pkId, SCORE: scoreActual } = result.recordset[0];

            if (score > scoreActual) {
                await pool.request()
                    .input('pk_id', sql.Int,     pkId)   // ← usa la PK, no el RFID
                    .input('score', sql.Int,     score)
                    .input('usr',   sql.VarChar, usr)
                    .query(`UPDATE puntuaciones
                            SET SCORE = @score, USR = @usr, LAST_GAME = GETDATE()
                            WHERE ID = @pk_id`);         // ← WHERE por PK, único e inequívoco
                console.log(`[SQL] Nuevo record: ${score} (anterior: ${scoreActual}) | PK: ${pkId}`);
            } else {
                console.log(`[SQL] Score ${score} no supera el record ${scoreActual}, se mantiene`);
            }

            res.status(200).json({
                status: 'ok',
                score_guardado: Math.max(score, scoreActual)
            });

        } else {
            await pool.request()
                .input('id_rfid',   sql.VarChar, id_rfid)
                .input('usr',       sql.VarChar, usr)
                .input('score',     sql.Int,     score)
                .input('name_disp', sql.VarChar, name_disp)
                .query(`INSERT INTO puntuaciones (ID_RFID, USR, SCORE, NAME_DISP)
                        VALUES (@id_rfid, @usr, @score, @name_disp)`);
            console.log(`[SQL] Jugador nuevo insertado con ${score} pts`);

            res.status(200).json({ status: 'ok', score_guardado: score });
        }

    } catch (err) {
        console.error('[ERROR POST]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── 2. GET: ESP32 llama aqui al escanear tarjeta → llena el buzon ──
app.get('/api/puntuaciones/:rfid', async (req, res) => {
    const rfid = req.params.rfid;
    console.log(`[GET] Tarjeta escaneada: ${rfid}`);

    try {
        let pool   = await sql.connect(dbConfig);
        let result = await pool.request()
            .input('id_rfid', sql.VarChar, rfid)
            .query(`SELECT SCORE, USR FROM puntuaciones WHERE ID_RFID = @id_rfid`);

        if (result.recordset.length > 0) {
            const row = result.recordset[0];
            buzon = { id_rfid: rfid, usr: row.USR, score: row.SCORE, name_disp: "Arcade" };
            res.status(200).json({ existe: true, score: row.SCORE, usr: row.USR });
        } else {
            const usr = `User_${rfid.substring(0, 4)}`;
            buzon = { id_rfid: rfid, usr: usr, score: 0, name_disp: "Arcade" };
            res.status(200).json({ existe: false, score: 0, usr: usr });
        }

    } catch (err) {
        console.error('[ERROR GET]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── 3. GET: Python hace polling aqui → recibe el buzon y lo vacia ──
app.get('/api/ultimo-movimiento', (req, res) => {
    res.status(200).json(buzon);
    // Vaciar el buzon para que Python no lo lea doble
    buzon = { id_rfid: "--------", usr: "Esperando...", score: 0, name_disp: "Ninguno" };
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Servidor corriendo en puerto ${PORT}`);
});