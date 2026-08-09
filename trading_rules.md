CORE BOT WORKFLOW - BINANCE FUTURES ICT/SMC

Tài liệu này là nguồn chuẩn cho core sizing, risk, execution và entry flow của bot.
Nếu có xung đột với ghi chú cũ bên dưới, section CORE BOT WORKFLOW này được ưu tiên.

1. Position sizing theo workflow Binance Futures

Bot không được tính quantity từ balance, risk percent hoặc khoảng cách stop loss.

Trader luôn quyết định:

- Margin per trade
- Leverage

Bot tính:

```text
Position Size = Margin Per Trade * Leverage
Quantity = Position Size / Entry Price
```

Ví dụ:

```text
Margin Per Trade = 200 USDT
Leverage = 5x
Position Size = 1000 USDT
Entry Price = 64000
Quantity = 1000 / 64000
```

Quantity sau đó phải được làm tròn theo Binance Futures `LOT_SIZE.stepSize`.

Stop loss không được dùng để resize position.
Stop loss chỉ dùng để:

- Bảo vệ lệnh
- Tính estimated loss
- Tính Risk/Reward
- Hiển thị lên dashboard/chart

Sau khi đã có quantity:

```text
Estimated Loss = abs(Entry - StopLoss) * Quantity
Estimated Profit = abs(TakeProfit - Entry) * Quantity
Risk Reward = Estimated Profit / Estimated Loss
```

Các giá trị cấu hình chính:

```env
POSITION_SIZING_MODE=fixed-margin
MARGIN_PER_TRADE=200
LEVERAGE=5
ENTRY_MODE=market
```

2. Risk engine

Risk engine không được tính quantity và không được tự động giảm size.

Risk engine chỉ validate trade có được phép vào hay không.

Validate:

- Available Balance
- Margin Requirement
- Minimum Notional
- Maximum Position Size
- Maximum Open Positions
- Daily Loss Breaker
- Drawdown Breaker
- Kill Switch
- Leverage Limits

Nếu validate fail thì reject trade.
Không được tự sửa margin, leverage, quantity hoặc position size.

3. Binance Futures execution

Bot hỗ trợ:

- LIMIT entry
- MARKET entry

Cả hai mode đều dùng chung sizing model:

```text
Quantity = Margin Per Trade * Leverage / Entry Price
```

Order flow khi setup hợp lệ:

```text
Read Margin
Read Leverage
Calculate Position Size
Calculate Quantity
Validate Risk
Set Binance Leverage
Submit Entry Order
Submit Stop Loss Order
Submit Take Profit Order
```

Entry order:

- Bullish setup: BUY
- Bearish setup: SELL

Exit orders:

- Bullish setup: SELL stop loss / SELL take profit
- Bearish setup: BUY stop loss / BUY take profit

Stop loss và take profit phải là reduce-only exit orders.

4. Entry model duy nhất được hỗ trợ

Bot phải đi đúng flow sau:

```text
EMA Trend H1
-> HTF FVG H1
-> HTF FVG mitigated
-> M5 BOS/CHOCH close phá swing
-> chờ M5 FVG mới cùng hướng
-> chờ giá pullback mitigate M5 FVG
-> tính entry/SL/TP
-> risk validate fixed-margin
-> submit entry + SL + TP
```

Bot không được vào lệnh ngay sau BOS/CHOCH.

M5 FVG mới và việc price pullback mitigate M5 FVG là bắt buộc trước khi submit order.

5. Step 1 - HTF H1 trend and FVG

HTF dùng H1.

Điều kiện bắt buộc:

- EMA xác nhận trend.
- Có HTF FVG H1 hợp lệ cùng hướng trend.
- Giá mitigate HTF FVG.

Mitigation mode của HTF FVG có thể cấu hình:

- Edge
- CE
- Full Fill

Nếu HTF FVG chưa được mitigate thì không trade.

6. Step 2 - LTF M5 BOS/CHOCH

Sau khi HTF FVG được mitigate, bot chuyển sang M5 và chờ market structure shift.

Chấp nhận:

- BOS
- CHOCH

Quy tắc bullish:

- Candle close phải đóng trên previous swing high.
- Wick break không tính.

Quy tắc bearish:

- Candle close phải đóng dưới previous swing low.
- Wick break không tính.

Nếu không có BOS/CHOCH thì không trade.

7. Step 3 - New M5 FVG after BOS/CHOCH

Sau BOS/CHOCH, bot phải chờ một FVG mới trên M5.

FVG M5 mới phải cùng hướng với BOS/CHOCH và HTF direction.

Ví dụ:

```text
Bearish HTF
-> Bearish BOS/CHOCH
-> Bearish M5 FVG
```

```text
Bullish HTF
-> Bullish BOS/CHOCH
-> Bullish M5 FVG
```

Nếu không có FVG M5 mới thì không trade.

8. Step 4 - Entry after M5 FVG mitigation

Bot không được enter ngay khi FVG M5 vừa tạo.

Bot phải chờ price pullback vào FVG M5.

Entry mitigation mode của M5 FVG có thể cấu hình:

- Edge
- CE
- Full Fill

Khi price mitigate M5 FVG theo mode đã cấu hình, bot mới tính entry plan và submit order.

Config:

```env
LTF_FVG_ENTRY_MODE=ce
```

9. Stop loss

Stop loss không dùng swing high/swing low nữa.

SL phải nằm ngoài M5 FVG.

Bullish:

```text
SL = M5 FVG lower boundary - buffer
```

Bearish:

```text
SL = M5 FVG upper boundary + buffer
```

Buffer hỗ trợ:

- Ticks
- Percentage
- ATR

Config:

```env
STOP_LOSS_BUFFER_MODE=ticks
STOP_LOSS_BUFFER_TICKS=5
STOP_LOSS_BUFFER_PERCENT=0.1
STOP_LOSS_ATR_PERIOD=14
STOP_LOSS_ATR_MULTIPLIER=1
PRICE_TICK_SIZE=0.1
```

10. Take profit

Default TP là nearest HTF external liquidity.

Bullish:

- Target buy-side liquidity.

Bearish:

- Target sell-side liquidity.

Fixed RR vẫn phải được hỗ trợ như fallback hoặc mode tùy chọn.

Config:

```env
TAKE_PROFIT_MODE=external-liquidity
FIXED_RR=2
```

11. Optional displacement filter

Để lọc BOS/CHOCH yếu trong thị trường đi ngang, bot có thể yêu cầu candle tạo BOS/CHOCH là displacement candle.

Displacement candle:

- Body lớn hơn trung bình body các nến trước đó.
- Close mạnh theo đúng hướng break.
- Có thể dùng như điều kiện bắt buộc trước khi chấp nhận BOS/CHOCH.

Config:

```env
REQUIRE_DISPLACEMENT=false
DISPLACEMENT_BODY_MULTIPLIER=1.5
DISPLACEMENT_LOOKBACK=20
```

Khi `REQUIRE_DISPLACEMENT=true`, BOS/CHOCH không đạt displacement filter phải bị ignore.

12. Database fields cần lưu

Mỗi trade/risk decision cần lưu:

- Margin
- Leverage
- Position Size
- Quantity
- Entry
- Stop Loss
- Take Profit
- Estimated Loss
- Estimated Profit
- Risk Reward

13. Frontend fields cần hiển thị

Dashboard cần hiển thị:

- Margin Used
- Leverage
- Position Size
- Quantity
- Estimated Loss
- Estimated Profit
- Risk Reward

==================================================

Định nghĩa chính xác FVG (điều kiện tạo, điều kiện bị vô hiệu).

FVG (Fair Value Gap - Khoảng trống giá trị hợp lý) là vùng mất cân bằng cung cầu xuất hiện trên biểu đồ, được cấu thành từ ba cây nến liên tiếp khi giá biến động quá nhanh, bao gồm điều kiện tạo ra và điều kiện bị vô hiệu hóa rõ ràng.Điều kiện tạo FVGMô hình 3 nến: Quan sát chuỗi 3 nến liên tiếp (Nến 1, Nến 2, Nến 3).Khoảng trống giá:FVG tăng (Bullish FVG): Râu của Nến 3 không chạm vào râu của Nến 1. Vùng trống nằm giữa đỉnh râu nến 1 và đáy râu nến 3.FVG giảm (Bearish FVG): Râu của Nến 3 không chạm vào râu của Nến 1. Vùng trống nằm giữa đáy râu nến 1 và đỉnh râu nến 3.Nguyên nhân: Lực mua hoặc lực bán quá mạnh từ dòng tiền lớn (thị trường mất cân đối) khiến các mức giá trung gian bị bỏ qua không có giao dịch khớp lệnh.Điều kiện FVG bị vô hiệu hóaBị xuyên thủng hoàn toàn: Giá quay đầu và một cây nến sau đó di chuyển mạnh, phá vỡ và đóng cửa hoàn toàn vượt qua khỏi giới hạn của vùng FVG.Chuyển thành IFVG: Khi một FVG bị phá vỡ dứt khoát như vậy, nó biến thành Khoảng trống giá trị hợp lý đảo ngược (Inversion Fair Value Gap - IFVG).Đảo chiều vai trò: Vùng hỗ trợ ban đầu của FVG tăng giờ chuyển thành kháng cự, hoặc vùng kháng cự của FVG giảm chuyển thành hỗ trợ cho nhịp di chuyển mới của giá.

Định nghĩa BOS và CHOCH (nến phải đóng qua thân hay chỉ cần vượt đỉnh/đáy, cách xác định swing).

BOS và CHOCH là hai tín hiệu cấu trúc thị trường quan trọng: BOS xác nhận tiếp diễn xu hướng, CHOCH báo hiệu thay đổi xu hướng, và việc phá vỡ hợp lệ yêu cầu thân nến phải đóng cửa vượt qua đỉnh hoặc đáy, chứ không chỉ dùng râu nến quét qua để tránh tín hiệu giả.Định nghĩa BOS và CHOCHBOS (Break of Structure - Phá vỡ cấu trúc): Xảy ra khi giá phá vỡ một đỉnh (trong xu hướng tăng) hoặc một đáy (trong xu hướng giảm) gần nhất để tiếp tục đi theo hướng xu hướng hiện tại.CHOCH (Change of Character - Thay đổi tính chất): Xảy ra khi giá phá vỡ ngược lại mốc đỉnh/đáy quan trọng gần nhất của xu hướng cũ, đánh dấu sự chuyển đổi từ tăng sang giảm hoặc ngược lại.Quy tắc đóng nến (Thân nến hay Râu nến?)Bắt buộc đóng qua thân nến: Một điểm phá vỡ (BOS hay CHOCH) chỉ được công nhận là hợp lệ khi có thân nến đóng cửa (close body) vượt hẳn qua mức giá của đỉnh hoặc đáy.Trường hợp chỉ vượt râu nến: Nếu giá chỉ dùng râu nến (wick) đâm thủng đỉnh/đáy rồi quay đầu, đó chỉ là hành động quét thanh khoản (sweep/liquidity) hoặc tín hiệu nhiễu, không phải là BOS hay CHOCH hợp lệ.Cách xác định điểm Swing (Đỉnh/Đáy dao động)Xác định Swing High (Đỉnh swing): Là một nến có giá cao nhất nằm ở giữa, được bao quanh bởi các nến có giá cao thấp hơn ở cả hai bên trái và phải.Xác định Swing Low (Đáy swing): Là một nến có giá thấp nhất nằm ở giữa, được bao quanh bởi các nến có giá thấp cao hơn ở cả hai bên trái và phải.Lọc nhiễu: Chỉ tính các điểm swing chính tạo ra cấu trúc xu hướng, bỏ qua các biến động nhỏ bên trong.

Định nghĩa Internal Liquidity và External Liquidity theo đúng cách bạn giao dịch.

Internal Liquidity và External Liquidity trong giao dịch theo mô hình Price Action (ICT/SMC) là các vùng giá tập trung lệnh chờ khớp, phân chia theo vị trí nằm bên trong hay bên ngoài biên độ dao động hiện tại.External Liquidity (Thanh khoản ngoại vi): Các vùng đỉnh/đáy chính như Swing High/Low, Equal Highs/Lows (EQH/EQL), và các mức cao/thấp của ngày/tuần/tháng trước.Internal Liquidity (Thanh khoản nội vi): Các vùng mất cân bằng và tích lũy bên trong cấu trúc như Fair Value Gap (FVG), Order Block (OB), và Breaker Block.External Liquidity (Thanh khoản ngoại vi)Vị trí: Nằm ở các cực của biểu đồ giá, nơi các nhà giao dịch bán lẻ thường đặt lệnh dừng lỗ (Stop Loss) hoặc điểm phá vỡ (Breakout).Đặc điểm:Gồm các mức Swing High, Swing Low rõ ràng.Gồm các đỉnh đáy bằng nhau (Equal Highs hoặc Equal Lows).Cách sử dụng trong giao dịch:Chờ giá quét (Sweep/Run) qua các vùng này để kích hoạt thanh khoản lớn trước khi đảo chiều.Thường là mục tiêu (Target) để chốt lời của các lệnh đang chạy.Internal Liquidity (Thanh khoản nội vi)Vị trí: Nằm ở bên trong khoảng dao động giá giữa các vùng thanh khoản ngoại vi.Đặc điểm:Gồm các vùng giá chưa được khớp lệnh hết như Fair Value Gap (FVG).Gồm các vùng khối lệnh tiềm năng như Order Block (OB).Cách sử dụng trong giao dịch:Dùng làm vùng mục tiêu chuyển tiếp (giá di chuyển từ External vào Internal hoặc ngược lại).Tìm điểm vào lệnh (Entry) tại các vùng này sau khi External Liquidity đã bị quét.

Điều kiện nào được coi là "chạm FVG" (chạm mép, chạm 50%, hay fill toàn bộ vùng).

Trong phương pháp Price Action và Smart Money Concepts (SMC/ICT), cả ba trường hợp trên đều được coi là các dạng "chạm" hoặc "lấp đầy" FVG (Fair Value Gap), nhưng chúng mang ý nghĩa và độ uy tín khác nhau đối với phản ứng của giá.Chạm mép (Bắt đầu chạm biên/Outer Boundary): Giá chỉ mới quét qua cạnh ngoài cùng của vùng FVG.Chạm 50% (Consequent Encroachment - CE): Giá hồi về đúng mốc trung bình giữa vùng khoảng trống giá.Fill toàn bộ vùng (Full Fill / Mitigation hoàn toàn): Giá xuyên qua và lấp đầy 100% khoảng trống của FVG.Ý nghĩa chi tiết của từng mức độChạm mép (Tập trung vào phản ứng nhanh)Định nghĩa: Giá vừa nhúng râu nến hoặc chạm vào đường biên ngoài cùng (cạnh gần nhất của cây nến thứ nhất tạo ra FVG).Đặc điểm: Thường xảy ra trong các xu hướng cực mạnh (strong trend), khi thị trường không có đủ thời gian hồi sâu mà chỉ cần chạm mép là bật đi tiếp.Độ tin cậy: Phản ứng có thể rất nhanh nhưng rủi ro quét lệnh cao nếu lực hồi mạnh hơn dự kiến.Chạm 50% hay Mức ngưỡng trung bình (Consequent Encroachment - CE)Định nghĩa: Giá tiến sâu vào và chạm đúng mốc 50% (giữa đỉnh và đáy của khoảng trống FVG).Đặc điểm: Đây được xem là điểm cân bằng (equilibrium) chuẩn của một FVG trong lý thuyết ICT. Vùng 50% này đóng vai trò như một nam châm hút giá và là vị trí đặt lệnh tối ưu (sniper entry) phổ biến nhất của các trader chuyên nghiệp để tối ưu tỷ lệ Risk:Reward.Độ tin cậy: Rất cao vì thể hiện thị trường đã test đủ lượng thanh khoản cần thiết trước khi tiếp tục xu hướng chính.Fill toàn bộ vùng (Full Fill)Định nghĩa: Giá quét qua toàn bộ khoảng trống từ mép trên đến mép dưới của FVG (lấp đầy 100% vùng mất cân bằng).Đặc điểm: Khi giá fill toàn bộ, vùng FVG đó được coi là đã được sử dụng xong (mitigated hoàn toàn).Độ tin cậy: Ý nghĩa giữ giá làm hỗ trợ/kháng cự của FVG này sẽ giảm đi cho các lần chạm tiếp theo. Nếu giá đóng cửa vượt qua khỏi biên bên kia của FVG, cấu trúc này có thể chuyển hóa thành vùng đảo chiều (ví dụ: Inverse FVG).

Quy tắc chỉ lấy setup đầu tiên hay cho phép nhiều lần retest.

Trong giao dịch theo trường phái Price Action hoặc Support/Resistance, việc chỉ lấy setup đầu tiên hay cho phép nhiều lần retest phụ thuộc vào chất lượng của mức cản, biến động thị trường và quản trị rủi ro, chứ không có quy tắc tuyệt đối. Bạn có thể cân nhắc cả hai cách tiếp cận tùy theo chiến lược:Quy tắc với Setup Đầu TiênĐộ uy tín cao nhất: Lần chạm đầu tiên (fresh level) thường có phản ứng mạnh nhất vì lượng lệnh chờ sẵn còn nhiều.Tỷ lệ thắng tốt: Ít bị nhiễu bởi các tín hiệu giả hay việc vùng giá đã bị bào mòn qua nhiều lần test trước đó.Nhược điểm: Dễ bỏ lỡ cơ hội nếu giá không quay lại đúng điểm hoặc phá vỡ qua luôn mà không cho phản ứng.Quy tắc cho phép Nhiều Lần RetestXác nhận độ bền vững: Càng retest nhiều lần mà chưa phá vỡ, vùng cản đó càng được thị trường chú ý.Tăng cơ hội giao dịch: Cho phép bạn tìm điểm vào lệnh ở các lần test thứ 2 hoặc thứ 3 sau khi đã quan sát phản ứng ở lần 1.Rủi ro cạn kiệt: Lần retest càng về sau thì vùng cản càng yếu đi (lệnh chờ bị khớp hết), dễ dẫn đến tình trạng phá vỡ (breakout).Lời khuyên áp dụngƯu tiên lần 1 và 2: Chỉ nên giao dịch tối đa ở lần test thứ 2. Từ lần thứ 3 trở đi, khả năng cao giá sẽ phá vỡ vùng giá đó.Quan sát nến phản ứng: Luôn chờ tín hiệu nến đảo chiều (như pin bar, engulfing) tại vùng cản thay vì đặt lệnh chờ bán/mua mù quáng ở các lần retest sau.

Quy tắc hủy setup nếu giá đi quá xa hoặc FVG bị phá.

Quy tắc hủy setup khi giao dịch với vùng mất cân bằng giá [5.7, 5.8] (Fair Value Gap - FVG) gồm việc hủy lệnh khi giá vượt quá khoảng cách cho phép hoặc khi nến đóng cửa vượt qua giới hạn của vùng FVG.Khi nào nên hủy setup giao dịch?Giá đi quá xa vùng FVG:Giá chạy quá nhanh và vượt qua mục tiêu chờ đợi mà không có nhịp hồi về vùng cân bằng.Mất đi tính chính xác của cấu trúc thị trường ban đầu [5.4], rủi ro cao khi với theo giá (chase price).Vùng FVG bị phá vỡ (Invalidation):Giá đóng cửa (Close candle) hoàn toàn vượt qua mốc biên giới của FVG (vượt qua đáy của FVG tăng hoặc đỉnh của FVG giảm).Vùng FVG chuyển hóa thành vùng cản ngược lại hoặc biến thành FVG đảo ngược (IFVG), làm mất hiệu lực của lệnh chờ (pending order) cũ.
