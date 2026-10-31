using System.ComponentModel.DataAnnotations;

namespace Medcore.Application;

// Расписание приёма и талоны (миграция 008). Формы строк совпадают с клиентом:
// талон — плоская карточка со специальностью врача, запись — талон с пациентом.
// Время приёма хранится в timestamptz и трактуется в Europe/Moscow.

// specializationId/Name: основная специальность врача (doctor_specialties), а при её
// отсутствии — профиль отделения, где врач вёл госпитализации. Значения могут быть
// null, если у врача не заполнено ничего.
public sealed record SlotRow(long Id, long DoctorId, string DoctorName, long? SpecializationId,
    string? SpecializationName, long OrganizationId, string OrganizationName, DateTimeOffset StartsAt,
    DateTimeOffset EndsAt, string Status, string? Cabinet);

public sealed record SlotList(IReadOnlyList<SlotRow> Items);

public sealed record AppointmentRow(long Id, DateTimeOffset StartsAt, DateTimeOffset EndsAt, string Status,
    long PatientId, string PatientName, long DoctorId, string DoctorName, string? SpecializationName,
    long OrganizationId, string OrganizationName, string? Cabinet);

public sealed record AppointmentList(IReadOnlyList<AppointmentRow> Items);

// Тело POST /api/appointments: запись занимает свободный талон, обратный адрес — id талона.
public sealed record CreateAppointmentRequest(
    [property: Range(1, long.MaxValue)] long SlotId,
    [property: Range(1, long.MaxValue)] long PatientId,
    [property: Range(1, long.MaxValue)] long? ReferralId);

// Допустимые значения проверяет хранилище: оно возвращает 422 с русским текстом.
public sealed record AppointmentStatusRequest([property: Required, StringLength(20)] string Status);

// Строка расписания: slotsTotal/slotsFree считаются по талонам расписания.
public sealed record ScheduleRow(long Id, long DoctorId, string DoctorName, long OrganizationId,
    string OrganizationName, DateOnly WorkDate, string StartTime, string EndTime, int SlotMinutes,
    string? Cabinet, bool IsActive, int SlotsTotal, int SlotsFree);

public sealed record ScheduleList(IReadOnlyList<ScheduleRow> Items);

// Время приёма приходит строкой "ЧЧ:ММ": формат проверяет хранилище и отвечает 422,
// а не среда привязки модели — иначе ошибка формата превратилась бы в 400.
public sealed record CreateScheduleRequest(
    [property: Range(1, long.MaxValue)] long DoctorId,
    [property: Range(1, long.MaxValue)] long OrganizationId,
    DateOnly WorkDate,
    [property: StringLength(8)] string? StartTime,
    [property: StringLength(8)] string? EndTime,
    [property: Range(5, 240)] int SlotMinutes,
    [property: StringLength(100)] string? Cabinet);

public sealed record CreateScheduleResult(long Id, int SlotsCreated);

// Ответ POST /api/appointments: адрес записи — идентификатор талона.
public sealed record CreatedAppointment(long Id, DateTimeOffset StartsAt);
